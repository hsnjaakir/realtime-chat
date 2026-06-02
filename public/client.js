const socket = io();

const form = document.getElementById("form");
const input = document.getElementById("input");
const username = document.getElementById("username");
const messages = document.getElementById("messages");

const escapeHtml = (value) => {
  const p = document.createElement("p");
  p.textContent = value;
  return p.innerHTML;
};

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = input.value.trim();
  const name = username.value.trim();

  if (!text || !name) {
    return;
  }

  socket.emit("chat message", {
    user: name,
    text,
    createdAt: new Date().toLocaleTimeString()
  });

  input.value = "";
  input.focus();
});

socket.on("chat message", (payload) => {
  const item = document.createElement("li");
  item.innerHTML = `<strong>${escapeHtml(payload.user)}</strong> <span class="timestamp">${escapeHtml(payload.createdAt)}</span><br>${escapeHtml(payload.text)}`;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
});
