require("dotenv").config();
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const DEFAULT_ROOM = "general";
const ONLINE_USERS = new Map();
const PASSWORD_RESET_TOKEN_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 30);
const DEV_EXPOSE_RESET_TOKEN = process.env.DEV_EXPOSE_RESET_TOKEN === "true";

class ChatStore {
  constructor() {
    this.usePostgres = Boolean(process.env.DATABASE_URL);
    if (this.usePostgres) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    } else {
      this.sqlite = new Database(path.join(__dirname, "chat.db"));
      this.sqlite.pragma("journal_mode = WAL");
    }
  }

  async init() {
    if (this.usePostgres) {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(32) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          room VARCHAR(64),
          sender_id INTEGER NOT NULL REFERENCES users(id),
          recipient_id INTEGER REFERENCES users(id),
          body TEXT NOT NULL,
          is_private BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          used_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await this.pool.query(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0"
      );
      return;
    }

    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        sender_id INTEGER NOT NULL,
        recipient_id INTEGER,
        body TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(recipient_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    const userColumns = this.sqlite.prepare("PRAGMA table_info(users)").all();
    const hasTokenVersion = userColumns.some((column) => column.name === "token_version");
    if (!hasTokenVersion) {
      this.sqlite.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
    }
  }

  async createUser(username, passwordHash) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, token_version",
        [username, passwordHash]
      );
      return result.rows[0];
    }

    const stmt = this.sqlite.prepare(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)"
    );
    const result = stmt.run(username, passwordHash);
    return { id: Number(result.lastInsertRowid), username, token_version: 0 };
  }

  async findUserByUsername(username) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        "SELECT id, username, password_hash FROM users WHERE username = $1",
        [username]
      );
      return result.rows[0] || null;
    }

    const row = this.sqlite
      .prepare("SELECT id, username, password_hash, token_version FROM users WHERE username = ?")
      .get(username);
    return row || null;
  }

  async findUserById(id) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        "SELECT id, username FROM users WHERE id = $1",
        [id]
      );
      return result.rows[0] || null;
    }

    const row = this.sqlite
      .prepare("SELECT id, username, token_version FROM users WHERE id = ?")
      .get(id);
    return row || null;
  }

  async updateUserPassword(userId, passwordHash) {
    if (this.usePostgres) {
      await this.pool.query(
        "UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2",
        [passwordHash, userId]
      );
      return;
    }

    this.sqlite
      .prepare(
        "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?"
      )
      .run(passwordHash, userId);
  }

  async bumpTokenVersion(userId) {
    if (this.usePostgres) {
      await this.pool.query(
        "UPDATE users SET token_version = token_version + 1 WHERE id = $1",
        [userId]
      );
      return;
    }

    this.sqlite
      .prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?")
      .run(userId);
  }

  async createResetToken(userId, tokenHash, expiresAtIso) {
    if (this.usePostgres) {
      await this.pool.query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [userId, tokenHash, expiresAtIso]
      );
      return;
    }

    this.sqlite
      .prepare(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)"
      )
      .run(userId, tokenHash, expiresAtIso);
  }

  async consumeResetToken(tokenHash) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        `
          UPDATE password_reset_tokens
          SET used_at = NOW()
          WHERE id = (
            SELECT id
            FROM password_reset_tokens
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
            ORDER BY id DESC
            LIMIT 1
          )
          RETURNING user_id
        `,
        [tokenHash]
      );
      return result.rows[0] || null;
    }

    const row = this.sqlite
      .prepare(
        `
          SELECT id, user_id
          FROM password_reset_tokens
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(tokenHash);
    if (!row) {
      return null;
    }

    this.sqlite
      .prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?")
      .run(row.id);
    return { user_id: row.user_id };
  }

  async saveRoomMessage(room, senderId, body) {
    if (this.usePostgres) {
      await this.pool.query(
        "INSERT INTO messages (room, sender_id, body, is_private) VALUES ($1, $2, $3, FALSE)",
        [room, senderId, body]
      );
      return;
    }

    this.sqlite
      .prepare(
        "INSERT INTO messages (room, sender_id, body, is_private) VALUES (?, ?, ?, 0)"
      )
      .run(room, senderId, body);
  }

  async savePrivateMessage(senderId, recipientId, body) {
    if (this.usePostgres) {
      await this.pool.query(
        "INSERT INTO messages (sender_id, recipient_id, body, is_private) VALUES ($1, $2, $3, TRUE)",
        [senderId, recipientId, body]
      );
      return;
    }

    this.sqlite
      .prepare(
        "INSERT INTO messages (sender_id, recipient_id, body, is_private) VALUES (?, ?, ?, 1)"
      )
      .run(senderId, recipientId, body);
  }

  async getRoomHistory(room, limit = 50) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        `
          SELECT m.id, m.room, m.body, m.is_private, m.created_at,
                 sender.username AS sender_username
          FROM messages m
          JOIN users sender ON sender.id = m.sender_id
          WHERE m.room = $1 AND m.is_private = FALSE
          ORDER BY m.created_at DESC
          LIMIT $2
        `,
        [room, limit]
      );
      return result.rows.reverse().map((row) => ({
        id: row.id,
        room: row.room,
        text: row.body,
        isPrivate: false,
        from: row.sender_username,
        createdAt: new Date(row.created_at).toISOString()
      }));
    }

    const rows = this.sqlite
      .prepare(
        `
          SELECT m.id, m.room, m.body, m.created_at,
                 sender.username AS sender_username
          FROM messages m
          JOIN users sender ON sender.id = m.sender_id
          WHERE m.room = ? AND m.is_private = 0
          ORDER BY m.id DESC
          LIMIT ?
        `
      )
      .all(room, limit);

    return rows.reverse().map((row) => ({
      id: row.id,
      room: row.room,
      text: row.body,
      isPrivate: false,
      from: row.sender_username,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async getPrivateHistory(userId, otherUserId, limit = 50) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        `
          SELECT m.id, m.body, m.created_at,
                 sender.username AS sender_username,
                 recipient.username AS recipient_username
          FROM messages m
          JOIN users sender ON sender.id = m.sender_id
          JOIN users recipient ON recipient.id = m.recipient_id
          WHERE m.is_private = TRUE
            AND ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
          ORDER BY m.created_at DESC
          LIMIT $3
        `,
        [userId, otherUserId, limit]
      );
      return result.rows.reverse().map((row) => ({
        id: row.id,
        type: "private",
        from: row.sender_username,
        to: row.recipient_username,
        text: row.body,
        createdAt: new Date(row.created_at).toISOString()
      }));
    }

    const rows = this.sqlite
      .prepare(
        `
          SELECT m.id, m.body, m.created_at,
                 sender.username AS sender_username,
                 recipient.username AS recipient_username
          FROM messages m
          JOIN users sender ON sender.id = m.sender_id
          JOIN users recipient ON recipient.id = m.recipient_id
          WHERE m.is_private = 1
            AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
          ORDER BY m.id DESC
          LIMIT ?
        `
      )
      .all(userId, otherUserId, otherUserId, userId, limit);

    return rows.reverse().map((row) => ({
      id: row.id,
      type: "private",
      from: row.sender_username,
      to: row.recipient_username,
      text: row.body,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
}

const store = new ChatStore();

const makeToken = (user) =>
  jwt.sign(
    { userId: user.id, username: user.username, tokenVersion: Number(user.token_version || 0) },
    JWT_SECRET,
    {
    expiresIn: "24h"
    }
  );

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await store.findUserById(decoded.userId);
    if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
      res.status(401).json({ error: "Session expired. Please login again." });
      return;
    }
    req.user = decoded;
    next();
  } catch (_error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!username || !password || username.length > 32 || password.length < 6) {
    res.status(400).json({ error: "Use valid username and 6+ char password" });
    return;
  }

  try {
    const exists = await store.findUserByUsername(username);
    if (exists) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await store.createUser(username, hash);
    const token = makeToken(user);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) {
    res.status(500).json({ error: "Registration failed" });
    console.error(error);
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  try {
    const user = await store.findUserByUsername(username);
    if (!user) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const token = makeToken(user);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
    console.error(error);
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await store.findUserById(req.user.userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user });
});

app.post("/api/logout", authMiddleware, async (req, res) => {
  await store.bumpTokenVersion(req.user.userId);
  res.json({ ok: true });
});

app.post("/api/password-reset/request", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  if (!username) {
    res.status(400).json({ error: "Username is required" });
    return;
  }

  const user = await store.findUserByUsername(username);
  if (!user) {
    res.json({ ok: true });
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
  await store.createResetToken(user.id, tokenHash, expiresAt);

  const response = { ok: true };
  if (DEV_EXPOSE_RESET_TOKEN) {
    response.devResetToken = resetToken;
  }
  res.json(response);
});

app.post("/api/password-reset/confirm", async (req, res) => {
  const resetToken = String(req.body.token || "");
  const newPassword = String(req.body.newPassword || "");

  if (!resetToken || newPassword.length < 6) {
    res.status(400).json({ error: "Token and 6+ char password are required" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const tokenRow = await store.consumeResetToken(tokenHash);
  if (!tokenRow) {
    res.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  const nextHash = await bcrypt.hash(newPassword, 10);
  await store.updateUserPassword(tokenRow.user_id, nextHash);
  res.json({ ok: true });
});

app.get("/api/private-history/:username", authMiddleware, async (req, res) => {
  const otherUsername = String(req.params.username || "").trim().toLowerCase();
  if (!otherUsername) {
    res.status(400).json({ error: "Username is required" });
    return;
  }

  const other = await store.findUserByUsername(otherUsername);
  if (!other) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const history = await store.getPrivateHistory(req.user.userId, other.id);
  res.json({ messages: history });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    next(new Error("Unauthorized"));
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    store
      .findUserById(decoded.userId)
      .then((user) => {
        if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
          next(new Error("Unauthorized"));
          return;
        }
        socket.data.user = { id: decoded.userId, username: decoded.username };
        next();
      })
      .catch(() => next(new Error("Unauthorized")));
  } catch (_error) {
    next(new Error("Unauthorized"));
  }
});

const emitOnlineUsers = () => {
  const users = [...ONLINE_USERS.values()].map((entry) => entry.username);
  users.sort((a, b) => a.localeCompare(b));
  io.emit("users:online", users);
};

io.on("connection", async (socket) => {
  const user = socket.data.user;
  const existing = ONLINE_USERS.get(user.id);
  if (existing) {
    existing.socketIds.add(socket.id);
  } else {
    ONLINE_USERS.set(user.id, { username: user.username, socketIds: new Set([socket.id]) });
  }

  socket.join(DEFAULT_ROOM);
  emitOnlineUsers();

  const history = await store.getRoomHistory(DEFAULT_ROOM);
  socket.emit("room:history", { room: DEFAULT_ROOM, messages: history });

  socket.on("room:join", async ({ room }) => {
    const safeRoom = String(room || "").trim().toLowerCase();
    if (!safeRoom) {
      return;
    }
    for (const joined of socket.rooms) {
      if (joined !== socket.id) {
        socket.leave(joined);
      }
    }
    socket.join(safeRoom);
    const roomHistory = await store.getRoomHistory(safeRoom);
    socket.emit("room:history", { room: safeRoom, messages: roomHistory });
  });

  socket.on("message:room", async ({ room, text }) => {
    const safeRoom = String(room || "").trim().toLowerCase();
    const safeText = String(text || "").trim();
    if (!safeRoom || !safeText) {
      return;
    }

    await store.saveRoomMessage(safeRoom, user.id, safeText);

    io.to(safeRoom).emit("message:new", {
      type: "room",
      room: safeRoom,
      from: user.username,
      text: safeText,
      createdAt: new Date().toISOString()
    });
  });

  socket.on("message:private", async ({ to, text }) => {
    const toUsername = String(to || "").trim().toLowerCase();
    const safeText = String(text || "").trim();
    if (!toUsername || !safeText || toUsername === user.username) {
      return;
    }

    const recipient = await store.findUserByUsername(toUsername);
    if (!recipient) {
      socket.emit("message:error", { error: `User "${toUsername}" not found` });
      return;
    }

    await store.savePrivateMessage(user.id, recipient.id, safeText);

    const payload = {
      type: "private",
      from: user.username,
      to: recipient.username,
      text: safeText,
      createdAt: new Date().toISOString()
    };

    socket.emit("message:new", payload);
    const recipientOnline = ONLINE_USERS.get(recipient.id);
    if (recipientOnline) {
      for (const socketId of recipientOnline.socketIds) {
        io.to(socketId).emit("message:new", payload);
      }
    }
  });

  socket.on("private:history:get", async ({ withUser }) => {
    const target = String(withUser || "").trim().toLowerCase();
    if (!target || target === user.username) {
      socket.emit("private:history", { withUser: target, messages: [] });
      return;
    }
    const other = await store.findUserByUsername(target);
    if (!other) {
      socket.emit("message:error", { error: `User "${target}" not found` });
      return;
    }
    const history = await store.getPrivateHistory(user.id, other.id);
    socket.emit("private:history", { withUser: target, messages: history });
  });

  socket.on("disconnect", () => {
    const current = ONLINE_USERS.get(user.id);
    if (!current) {
      return;
    }
    current.socketIds.delete(socket.id);
    if (current.socketIds.size === 0) {
      ONLINE_USERS.delete(user.id);
    }
    emitOnlineUsers();
  });
});

const start = async () => {
  await store.init();
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
