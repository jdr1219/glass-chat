python3 << 'PYEOF'
server = r'''const express = require("express");
const http    = require("http");
const path    = require("path");
const { Server } = require("socket.io");

const log = {
  info:  (msg, d={}) => console.log(JSON.stringify({ level:"info",  msg, ...d, t: new Date().toISOString() })),
  warn:  (msg, d={}) => console.warn(JSON.stringify({ level:"warn",  msg, ...d, t: new Date().toISOString() })),
  error: (msg, d={}) => console.error(JSON.stringify({ level:"error", msg, ...d, t: new Date().toISOString() })),
};

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

const users      = {};
const history    = [];
const reactions  = {};
const rateLimits = {};
const MAX_HISTORY = 100;
const MAX_MSG_LEN = 2000;
const RATE_LIMIT  = 6;

function sanitize(str = "") {
  return str.replace(/</g, "&lt;").replace(/>/g, "&gt;").trim().slice(0, MAX_MSG_LEN);
}

function isRateLimited(id) {
  const now = Date.now();
  if (!rateLimits[id] || rateLimits[id].resetAt < now)
    rateLimits[id] = { count: 0, resetAt: now + 3000 };
  return ++rateLimits[id].count > RATE_LIMIT;
}

io.on("connection", socket => {
  log.info("connect", { id: socket.id });

  socket.on("join", rawName => {
    const username = sanitize(rawName).slice(0, 24);
    if (!username) return socket.emit("error", "Invalid name");
    if (Object.values(users).includes(username)) {
      return socket.emit("name-taken");
    }
    users[socket.id] = username;
    log.info("join", { username });
    const hist = history.map(m => ({
      ...m,
      reactions: Object.entries(reactions[m.id] || {})
        .map(([emoji, u]) => ({ emoji, users: [...u] }))
    }));
    socket.emit("history", hist);
    socket.broadcast.emit("system", `${username} joined`);
    io.emit("user-count", Object.keys(users).length);
  });

  socket.on("message", data => {
    const username = users[socket.id];
    if (!username) return;
    if (isRateLimited(socket.id)) return socket.emit("error", "Slow down");
    const text = sanitize(data.text || "");
    if (!text) return;
    const msg = {
      user: username, socketId: socket.id,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(), text, seenBy: [],
      replyTo: data.replyTo ? {
        id: data.replyTo.id,
        user: sanitize(data.replyTo.user || ""),
        text: sanitize(data.replyTo.text || "").slice(0, 100),
      } : null,
    };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    log.info("message", { from: username, len: text.length });
    io.emit("message", { ...msg, reactions: [] });
  });

  socket.on("react", ({ msgId, emoji }) => {
    const username = users[socket.id];
    if (!username || !msgId || !emoji) return;
    if (!reactions[msgId]) reactions[msgId] = {};
    if (!reactions[msgId][emoji]) reactions[msgId][emoji] = new Set();
    const set = reactions[msgId][emoji];
    set.has(username) ? set.delete(username) : set.add(username);
    if (!set.size) delete reactions[msgId][emoji];
    const snapshot = Object.entries(reactions[msgId] || {})
      .map(([e, u]) => ({ emoji: e, users: [...u] }));
    io.emit("reaction-update", { msgId, reactions: snapshot });
  });

  socket.on("seen", ({ id, reader }) => {
    const msg = history.find(m => m.id === id);
    if (msg && reader && !msg.seenBy.includes(reader)) {
      msg.seenBy.push(reader);
      io.emit("seen-update", { id, reader });
    }
  });

  socket.on("delete-msg", ({ id }) => {
    const username = users[socket.id];
    const msg = history.find(m => m.id === id && m.user === username);
    if (!msg) return;
    msg.deleted = true; msg.text = "";
    io.emit("msg-deleted", { id });
  });

  socket.on("typing", () => {
    const username = users[socket.id];
    if (username) socket.broadcast.emit("typing", username);
  });

  socket.on("disconnect", () => {
    const username = users[socket.id];
    delete users[socket.id]; delete rateLimits[socket.id];
    if (username) {
      log.info("leave", { username });
      io.emit("system", `${username} left`);
      io.emit("user-count", Object.keys(users).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log.info("listening", { port: PORT }));

function shutdown(signal) {
  log.info("shutdown", { signal });
  io.emit("system", "Server restarting — back in a moment.");
  server.close(() => { log.info("closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
'''
with open('/home/claude/glass-chat/server.js', 'w') as f:
    f.write(server)
print("server.js:", len(server))
PYEOF
