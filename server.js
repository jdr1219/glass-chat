const express = require("express");
const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const { Server } = require("socket.io");

const log = {
  info:  (msg, d={}) => console.log(JSON.stringify({ level:"info",  msg, ...d, t: new Date().toISOString() })),
  warn:  (msg, d={}) => console.warn(JSON.stringify({ level:"warn",  msg, ...d, t: new Date().toISOString() })),
  error: (msg, d={}) => console.error(JSON.stringify({ level:"error", msg, ...d, t: new Date().toISOString() })),
};

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || "*" }, maxHttpBufferSize: 4e6 });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

/* ── Best-effort disk persistence ───────────────────────────
   Survives crashes/restarts within the same container.
   NOTE: most hosting platforms (incl. Render's default web
   service disk) wipe local files on a fresh deploy — for true
   durability across deploys you'd want a managed database. */
const DATA_FILE = path.join(__dirname, "data", "rooms.json");
function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const room of Object.values(raw)) {
      for (const msg of room.history || []) {
        const plain = msg.reactionsRaw || {};
        msg.reactionsRaw = {};
        for (const [emoji, arr] of Object.entries(plain)) msg.reactionsRaw[emoji] = new Set(arr);
      }
    }
    return raw;
  } catch { return {}; }
}
function serializeRooms() {
  const out = {};
  for (const [name, room] of Object.entries(rooms)) {
    out[name] = {
      history: room.history.map(m => ({
        ...m,
        reactionsRaw: Object.fromEntries(Object.entries(m.reactionsRaw || {}).map(([e, s]) => [e, [...s]])),
      })),
    };
  }
  return out;
}
let saveTimer = null;
function saveRoomsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(serializeRooms()));
    } catch (e) { log.error("save-failed", { err: e.message }); }
  }, 800);
}

const MAX_HISTORY = 300;
const PAGE_SIZE   = 30;
const MAX_MSG_LEN = 2000;
const MAX_IMG_LEN = 600000; // ~450KB base64
const RATE_LIMIT  = 8;

const rooms = loadRooms();        // { roomName: { history: [...] } }
function getRoom(name) {
  if (!rooms[name]) rooms[name] = { history: [] };
  return rooms[name];
}

const users      = {};   // socket.id -> { name, room, avatar }
const rateLimits = {};

function sanitize(str = "", max = MAX_MSG_LEN) {
  return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim().slice(0, max);
}
function isRateLimited(id) {
  const now = Date.now();
  if (!rateLimits[id] || rateLimits[id].resetAt < now) rateLimits[id] = { count: 0, resetAt: now + 3000 };
  return ++rateLimits[id].count > RATE_LIMIT;
}
function roomUserList(room) {
  return Object.values(users).filter(u => u.room === room).map(u => u.name);
}
function publicMsg(m) {
  const { reactionsRaw, ...rest } = m;
  return {
    ...rest,
    reactions: Object.entries(reactionsRaw || {}).map(([emoji, set]) => ({ emoji, users: [...set] })),
  };
}

/* Open Graph link preview — no external API key needed */
const previewCache = new Map();
async function fetchPreview(url) {
  if (previewCache.has(url)) return previewCache.get(url);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 GlassChatBot" } });
    clearTimeout(t);
    const html = await res.text();
    const pick = re => (html.match(re) || [])[1];
    const preview = {
      url,
      title: pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || pick(/<title>([^<]+)<\/title>/i) || url,
      desc:  pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
          || pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || "",
      image: pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || null,
    };
    previewCache.set(url, preview);
    return preview;
  } catch { return null; }
}

io.on("connection", socket => {
  log.info("connect", { id: socket.id });

  socket.on("join", ({ name, room, avatar } = {}) => {
    const username = sanitize(name, 24);
    const roomName = sanitize(room || "general", 30) || "general";
    if (!username) return socket.emit("error-msg", "Invalid name");
    const taken = Object.values(users).some(u => u.room === roomName && u.name.toLowerCase() === username.toLowerCase());
    if (taken) return socket.emit("name-taken");

    users[socket.id] = { name: username, room: roomName, avatar: avatar && avatar.length < 50000 ? avatar : null };
    socket.join(roomName);
    log.info("join", { username, room: roomName });

    const r = getRoom(roomName);
    socket.emit("join-success", { room: roomName });
    socket.emit("history", r.history.slice(-PAGE_SIZE).map(publicMsg));
    socket.emit("history-has-more", r.history.length > PAGE_SIZE);
    socket.to(roomName).emit("system", `${username} joined`);
    io.to(roomName).emit("user-count", roomUserList(roomName).length);
  });

  socket.on("load-more", ({ before } = {}) => {
    const u = users[socket.id]; if (!u) return;
    const r = getRoom(u.room);
    const idx = r.history.findIndex(m => m.ts === before);
    const end = idx === -1 ? r.history.length : idx;
    const start = Math.max(0, end - PAGE_SIZE);
    socket.emit("more-history", { msgs: r.history.slice(start, end).map(publicMsg), hasMore: start > 0 });
  });

  socket.on("message", async data => {
    const u = users[socket.id]; if (!u) return;
    if (isRateLimited(socket.id)) return socket.emit("error-msg", "Slow down a little");
    const text = sanitize(data.text || "");
    const image = typeof data.image === "string" && data.image.length < MAX_IMG_LEN ? data.image : null;
    if (!text && !image) return;

    const r = getRoom(u.room);
    const msg = {
      user: u.name, socketId: socket.id, room: u.room,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(), text, image, edited: false, deleted: false,
      reactionsRaw: {},
      replyTo: data.replyTo ? {
        id: data.replyTo.id, user: sanitize(data.replyTo.user, 24), text: sanitize(data.replyTo.text, 100),
      } : null,
      seenBy: [],
    };
    r.history.push(msg);
    if (r.history.length > MAX_HISTORY) r.history.shift();
    saveRoomsDebounced();
    io.to(u.room).emit("message", publicMsg(msg));

    const urlMatch = text.match(/https?:\/\/[^\s<]+/);
    if (urlMatch) {
      const preview = await fetchPreview(urlMatch[0]);
      if (preview) io.to(u.room).emit("link-preview", { msgId: msg.id, preview });
    }
  });

  socket.on("edit-msg", ({ id, text }) => {
    const u = users[socket.id]; if (!u) return;
    const r = getRoom(u.room);
    const msg = r.history.find(m => m.id === id && m.user === u.name);
    if (!msg) return;
    msg.text = sanitize(text); msg.edited = true;
    saveRoomsDebounced();
    io.to(u.room).emit("msg-edited", { id, text: msg.text });
  });

  socket.on("delete-msg", ({ id }) => {
    const u = users[socket.id]; if (!u) return;
    const r = getRoom(u.room);
    const msg = r.history.find(m => m.id === id && m.user === u.name);
    if (!msg) return;
    msg.deleted = true; msg.text = ""; msg.image = null;
    saveRoomsDebounced();
    io.to(u.room).emit("msg-deleted", { id });
  });

  socket.on("react", ({ msgId, emoji }) => {
    const u = users[socket.id]; if (!u || !msgId || !emoji) return;
    const r = getRoom(u.room);
    const msg = r.history.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactionsRaw[emoji]) msg.reactionsRaw[emoji] = new Set();
    const set = msg.reactionsRaw[emoji];
    set.has(u.name) ? set.delete(u.name) : set.add(u.name);
    if (!set.size) delete msg.reactionsRaw[emoji];
    saveRoomsDebounced();
    const snapshot = Object.entries(msg.reactionsRaw).map(([e, s]) => ({ emoji: e, users: [...s] }));
    io.to(u.room).emit("reaction-update", { msgId, reactions: snapshot });
  });

  socket.on("seen", ({ id }) => {
    const u = users[socket.id]; if (!u) return;
    const r = getRoom(u.room);
    const msg = r.history.find(m => m.id === id);
    if (msg && !msg.seenBy.includes(u.name)) {
      msg.seenBy.push(u.name);
      io.to(u.room).emit("seen-update", { id, reader: u.name });
    }
  });

  socket.on("typing", () => {
    const u = users[socket.id];
    if (u) socket.to(u.room).emit("typing", u.name);
  });

  socket.on("disconnect", () => {
    const u = users[socket.id];
    delete users[socket.id]; delete rateLimits[socket.id];
    if (u) {
      log.info("leave", { username: u.name, room: u.room });
      io.to(u.room).emit("system", `${u.name} left`);
      io.to(u.room).emit("user-count", roomUserList(u.room).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log.info("listening", { port: PORT }));

function shutdown(signal) {
  log.info("shutdown", { signal });
  io.emit("system", "Server restarting — back in a moment.");
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializeRooms()));
  } catch {}
  server.close(() => { log.info("closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
