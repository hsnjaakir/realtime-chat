require("dotenv").config();
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
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
      return;
    }

    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
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
    `);
  }

  async createUser(username, passwordHash) {
    if (this.usePostgres) {
      const result = await this.pool.query(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
        [username, passwordHash]
      );
      return result.rows[0];
    }

    const stmt = this.sqlite.prepare(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)"
    );
    const result = stmt.run(username, passwordHash);
    return { id: Number(result.lastInsertRowid), username };
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
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
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
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(id);
    return row || null;
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
}

const store = new ChatStore();

const makeToken = (user) =>
  jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: "24h"
  });

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
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

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    next(new Error("Unauthorized"));
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.user = { id: decoded.userId, username: decoded.username };
    next();
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
