const authPanel = document.getElementById("authPanel");
const chatPanel = document.getElementById("chatPanel");
const authForm = document.getElementById("authForm");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const registerBtn = document.getElementById("registerBtn");
const authStatus = document.getElementById("authStatus");
const resetRequestForm = document.getElementById("resetRequestForm");
const resetUsername = document.getElementById("resetUsername");
const resetToken = document.getElementById("resetToken");
const resetNewPassword = document.getElementById("resetNewPassword");
const resetConfirmBtn = document.getElementById("resetConfirmBtn");
const resetStatus = document.getElementById("resetStatus");
const chatStatus = document.getElementById("chatStatus");
const currentUser = document.getElementById("currentUser");
const logoutBtn = document.getElementById("logoutBtn");
const roomInput = document.getElementById("roomInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const privateTo = document.getElementById("privateTo");
const loadPrivateHistoryBtn = document.getElementById("loadPrivateHistoryBtn");
const messages = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");

let socket = null;
let token = localStorage.getItem("chat_token") || "";
let user = null;
let activeRoom = "general";

const formatTime = (dateIso) =>
  new Date(dateIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const setStatus = (el, message, isError = false) => {
  el.textContent = message;
  el.classList.toggle("error", isError);
};

const pushMessage = (payload) => {
  const item = document.createElement("li");
  const mode = payload.type === "private" ? "PM" : `#${payload.room}`;
  const target = payload.type === "private" ? ` -> ${payload.to}` : "";
  item.innerHTML = `<strong>${payload.from}${target}</strong> <span class="timestamp">${mode} ${formatTime(payload.createdAt)}</span><br>${payload.text}`;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
};

const replaceHistory = (history) => {
  messages.innerHTML = "";
  history.forEach((msg) =>
    pushMessage({
      type: "room",
      room: msg.room,
      from: msg.from,
      text: msg.text,
      createdAt: msg.createdAt
    })
  );
};

const clearAuthSession = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  localStorage.removeItem("chat_token");
  token = "";
  user = null;
  activeRoom = "general";
  messages.innerHTML = "";
  authPanel.classList.remove("hidden");
  chatPanel.classList.add("hidden");
};

const setOnlineUsers = (users) => {
  const me = user?.username;
  const selected = privateTo.value;
  privateTo.innerHTML = '<option value="">Room (public)</option>';
  users
    .filter((name) => name !== me)
    .forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      privateTo.appendChild(option);
    });
  privateTo.value = users.includes(selected) ? selected : "";
};

const connectSocket = () => {
  if (!token) {
    return;
  }

  socket = io({ auth: { token } });

  socket.on("connect_error", () => {
    setStatus(chatStatus, "Socket auth failed. Please login again.", true);
    clearAuthSession();
  });

  socket.on("room:history", ({ room, messages: roomMessages }) => {
    activeRoom = room;
    roomInput.value = room;
    replaceHistory(roomMessages);
    setStatus(chatStatus, `Joined #${room}`);
  });

  socket.on("users:online", (users) => {
    setOnlineUsers(users);
  });

  socket.on("message:new", (payload) => {
    if (payload.type === "room" && payload.room !== activeRoom) {
      return;
    }
    pushMessage(payload);
  });

  socket.on("message:error", ({ error }) => {
    setStatus(chatStatus, error, true);
  });

  socket.on("private:history", ({ withUser, messages: privateMessages }) => {
    replaceHistory(privateMessages);
    setStatus(chatStatus, `Loaded private history with @${withUser}`);
  });
};

const setAuthenticatedUI = () => {
  authPanel.classList.add("hidden");
  chatPanel.classList.remove("hidden");
  currentUser.textContent = `Logged in as @${user.username}`;
};

const authRequest = async (mode) => {
  const username = authUsername.value.trim().toLowerCase();
  const password = authPassword.value;
  if (!username || !password) {
    setStatus(authStatus, "Username and password required.", true);
    return;
  }

  const response = await fetch(`/api/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();

  if (!response.ok) {
    setStatus(authStatus, data.error || "Auth failed.", true);
    return;
  }

  token = data.token;
  user = data.user;
  localStorage.setItem("chat_token", token);
  setStatus(authStatus, `${mode === "login" ? "Logged in" : "Registered"} as @${user.username}`);
  setAuthenticatedUI();
  connectSocket();
};

const authorizedFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    clearAuthSession();
  }
  return response;
};

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await authRequest("login");
});

registerBtn.addEventListener("click", async () => {
  await authRequest("register");
});

resetRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = resetUsername.value.trim().toLowerCase();
  if (!username) {
    setStatus(resetStatus, "Username is required.", true);
    return;
  }

  const response = await fetch("/api/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(resetStatus, data.error || "Reset request failed.", true);
    return;
  }

  if (data.devResetToken) {
    resetToken.value = data.devResetToken;
    setStatus(resetStatus, "Reset token generated (dev mode).");
    return;
  }

  setStatus(resetStatus, "If username exists, reset token has been issued.");
});

resetConfirmBtn.addEventListener("click", async () => {
  const tokenValue = resetToken.value.trim();
  const newPassword = resetNewPassword.value;
  if (!tokenValue || !newPassword) {
    setStatus(resetStatus, "Token and new password are required.", true);
    return;
  }

  const response = await fetch("/api/password-reset/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenValue, newPassword })
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(resetStatus, data.error || "Password reset failed.", true);
    return;
  }

  resetToken.value = "";
  resetNewPassword.value = "";
  setStatus(resetStatus, "Password updated. You can now login.");
});

logoutBtn.addEventListener("click", async () => {
  if (!token) {
    clearAuthSession();
    return;
  }
  await authorizedFetch("/api/logout", { method: "POST" });
  clearAuthSession();
});

joinRoomBtn.addEventListener("click", () => {
  const room = roomInput.value.trim().toLowerCase();
  if (!room || !socket) {
    return;
  }
  socket.emit("room:join", { room });
});

loadPrivateHistoryBtn.addEventListener("click", async () => {
  const recipient = privateTo.value;
  if (!recipient) {
    setStatus(chatStatus, "Choose a private recipient first.", true);
    return;
  }

  if (socket) {
    socket.emit("private:history:get", { withUser: recipient });
    return;
  }

  const response = await authorizedFetch(`/api/private-history/${encodeURIComponent(recipient)}`);
  const data = await response.json();
  if (!response.ok) {
    setStatus(chatStatus, data.error || "Failed to load private history.", true);
    return;
  }
  replaceHistory(data.messages);
  setStatus(chatStatus, `Loaded private history with @${recipient}`);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!socket) {
    return;
  }

  const text = input.value.trim();
  if (!text) {
    return;
  }

  const recipient = privateTo.value;
  if (recipient) {
    socket.emit("message:private", { to: recipient, text });
  } else {
    socket.emit("message:room", { room: activeRoom, text });
  }

  input.value = "";
  input.focus();
});

const bootstrapWithToken = async () => {
  if (!token) {
    return;
  }

  const response = await fetch("/api/me", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    localStorage.removeItem("chat_token");
    token = "";
    return;
  }

  const data = await response.json();
  user = data.user;
  setAuthenticatedUI();
  connectSocket();
};

bootstrapWithToken();
