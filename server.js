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

app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
function getSocketIp(handshake) {
  const xff = handshake.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return handshake.address || "unknown";
}

/* ── Best-effort disk persistence ───────────────────────────
   Survives crashes/restarts within the same container.
   NOTE: most hosting platforms (incl. Render's default web
   service disk) wipe local files on a fresh deploy — for true
   durability across deploys you'd want a managed database. */
const DATA_FILE = path.join(__dirname, "data", "messages.json");
function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const msg of raw) {
      const plain = msg.reactionsRaw || {};
      msg.reactionsRaw = {};
      for (const [emoji, arr] of Object.entries(plain)) msg.reactionsRaw[emoji] = new Set(arr);
    }
    return raw;
  } catch { return []; }
}
function serializeHistory() {
  return history.map(m => ({
    ...m,
    reactionsRaw: Object.fromEntries(Object.entries(m.reactionsRaw || {}).map(([e, s]) => [e, [...s]])),
  }));
}
let saveTimer = null;
function saveDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(serializeHistory()));
    } catch (e) { log.error("save-failed", { err: e.message }); }
  }, 800);
}

/* ── IP-keyed profile persistence (name + avatar) ──
   Lets returning visitors skip the "type your name" screen —
   we recognize their public IP and greet them straight into
   chat with their saved name/photo. NOTE: everyone behind the
   same public IP (e.g. same household/office NAT) shares one
   saved profile — a known tradeoff of IP-based recognition. */
const PROFILES_FILE = path.join(__dirname, "data", "profiles.json");
function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); }
  catch { return {}; }
}
let profileSaveTimer = null;
function saveProfilesDebounced() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles));
    } catch (e) { log.error("profile-save-failed", { err: e.message }); }
  }, 500);
}

const MAX_HISTORY = 300;
const PAGE_SIZE   = 30;
const MAX_MSG_LEN = 2000;
const MAX_IMG_LEN = 950000; // ~700KB base64, enough headroom for 1000px-wide JPEGs
const MAX_AVATAR_LEN = 300000; // small square photo, plenty of headroom
const RATE_LIMIT  = 8;

const history  = loadHistory();
const profiles = loadProfiles(); // ip -> { name, avatar, updatedAt }
const users      = {};   // socket.id -> { name, clientId, avatar }
const rateLimits = {};

function evictStaleSocket(clientId, exceptSocketId) {
  for (const [sid, u] of Object.entries(users)) {
    if (u.clientId === clientId && sid !== exceptSocketId) {
      const oldSocket = io.sockets.sockets.get(sid);
      if (oldSocket) oldSocket.disconnect(true);
      delete users[sid]; delete rateLimits[sid];
    }
  }
}

function sanitize(str = "", max = MAX_MSG_LEN) {
  return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim().slice(0, max);
}
function isRateLimited(id) {
  const now = Date.now();
  if (!rateLimits[id] || rateLimits[id].resetAt < now) rateLimits[id] = { count: 0, resetAt: now + 3000 };
  return ++rateLimits[id].count > RATE_LIMIT;
}
function publicMsg(m) {
  const { reactionsRaw, ...rest } = m;
  return {
    ...rest,
    reactions: Object.entries(reactionsRaw || {}).map(([emoji, set]) => ({ emoji, users: [...set] })),
  };
}
function validAvatar(a) {
  return typeof a === "string" && a.startsWith("data:image") && a.length < MAX_AVATAR_LEN ? a : null;
}

/* ── profile API: lets the client check/save the name+photo
   tied to the visitor's public IP ── */
app.get("/api/profile", (req, res) => {
  const ip = getClientIp(req);
  const p = profiles[ip];
  if (p) res.json({ exists: true, name: p.name, avatar: p.avatar || null });
  else res.json({ exists: false });
});

app.post("/api/profile", (req, res) => {
  const ip = getClientIp(req);
  const body = req.body || {};
  const name = sanitize(body.name, 24);
  if (!name) return res.status(400).json({ error: "Name required" });

  const existing = profiles[ip] || {};
  let avatar = existing.avatar || null;
  if ("avatar" in body) avatar = body.avatar === null ? null : validAvatar(body.avatar);

  profiles[ip] = { name, avatar, updatedAt: Date.now() };
  saveProfilesDebounced();
  res.json({ ok: true, name, avatar });
});

/* Sign out — forgets the profile saved against this visitor's IP so the
   auto-recognition above doesn't just log them straight back in on their
   next visit or page refresh. */
app.delete("/api/profile", (req, res) => {
  const ip = getClientIp(req);
  delete profiles[ip];
  saveProfilesDebounced();
  res.json({ ok: true });
});

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

  socket.on("join", ({ name, clientId, avatar } = {}) => {
    const username = sanitize(name, 24);
    const cid = sanitize(clientId, 64) || null;
    if (!username) return socket.emit("error-msg", "Invalid name");

    const conflict = Object.entries(users).find(
      ([sid, u]) => u.name.toLowerCase() === username.toLowerCase() && u.clientId !== cid
    );
    if (conflict) return socket.emit("name-taken");

    if (cid) evictStaleSocket(cid, socket.id); // drop any earlier session from this same browser
    users[socket.id] = { name: username, clientId: cid, avatar: validAvatar(avatar) };
    log.info("join", { username });

    socket.emit("join-success");
    socket.emit("history", history.slice(-PAGE_SIZE).map(publicMsg));
    socket.emit("history-has-more", history.length > PAGE_SIZE);
    socket.broadcast.emit("system", `${username} joined`);
    io.emit("user-count", Object.keys(users).length);
  });

  socket.on("update-profile", (data = {}) => {
    const u = users[socket.id]; if (!u) return;
    let newName = u.name;
    if (typeof data.name === "string") {
      const sn = sanitize(data.name, 24);
      if (sn && sn.toLowerCase() !== u.name.toLowerCase()) {
        const conflict = Object.entries(users).find(
          ([sid, x]) => sid !== socket.id && x.name.toLowerCase() === sn.toLowerCase()
        );
        if (conflict) return socket.emit("error-msg", "That name is already taken");
        newName = sn;
      } else if (sn) newName = sn;
    }
    let newAvatar = u.avatar;
    if ("avatar" in data) newAvatar = data.avatar === null ? null : validAvatar(data.avatar);

    const oldName = u.name;
    u.name = newName; u.avatar = newAvatar;
    socket.emit("profile-updated", { name: newName, avatar: newAvatar });
    if (oldName !== newName) io.emit("system", `${oldName} is now known as ${newName}`);

    // persist against this visitor's IP too, so it sticks on their next visit
    const ip = getSocketIp(socket.handshake);
    profiles[ip] = { name: newName, avatar: newAvatar, updatedAt: Date.now() };
    saveProfilesDebounced();
  });

  socket.on("load-more", ({ before } = {}) => {
    const username = users[socket.id]?.name; if (!username) return;
    const idx = history.findIndex(m => m.ts === before);
    const end = idx === -1 ? history.length : idx;
    const start = Math.max(0, end - PAGE_SIZE);
    socket.emit("more-history", { msgs: history.slice(start, end).map(publicMsg), hasMore: start > 0 });
  });

  socket.on("message", async data => {
    const username = users[socket.id]?.name; if (!username) return;
    if (isRateLimited(socket.id)) return socket.emit("error-msg", "Slow down a little");
    const text = sanitize(data.text || "");
    const image = typeof data.image === "string" && data.image.length < MAX_IMG_LEN ? data.image : null;
    if (!text && !image) return;

    const msg = {
      user: username, avatar: users[socket.id]?.avatar || null, socketId: socket.id,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(), text, image, edited: false, deleted: false,
      reactionsRaw: {},
      replyTo: data.replyTo ? {
        id: data.replyTo.id, user: sanitize(data.replyTo.user, 24), text: sanitize(data.replyTo.text, 100),
      } : null,
      seenBy: [],
    };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    saveDebounced();
    io.emit("message", publicMsg(msg));

    const urlMatch = text.match(/https?:\/\/[^\s<]+/);
    if (urlMatch) {
      const preview = await fetchPreview(urlMatch[0]);
      if (preview) io.emit("link-preview", { msgId: msg.id, preview });
    }
  });

  socket.on("edit-msg", ({ id, text }) => {
    const username = users[socket.id]?.name; if (!username) return;
    const msg = history.find(m => m.id === id && m.user === username);
    if (!msg) return;
    msg.text = sanitize(text); msg.edited = true;
    saveDebounced();
    io.emit("msg-edited", { id, text: msg.text });
  });

  socket.on("delete-msg", ({ id }) => {
    const username = users[socket.id]?.name; if (!username) return;
    const msg = history.find(m => m.id === id && m.user === username);
    if (!msg) return;
    msg.deleted = true; msg.text = ""; msg.image = null;
    saveDebounced();
    io.emit("msg-deleted", { id });
  });

  socket.on("react", ({ msgId, emoji }) => {
    const username = users[socket.id]?.name; if (!username || !msgId || !emoji) return;
    const msg = history.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactionsRaw[emoji]) msg.reactionsRaw[emoji] = new Set();
    const set = msg.reactionsRaw[emoji];
    set.has(username) ? set.delete(username) : set.add(username);
    if (!set.size) delete msg.reactionsRaw[emoji];
    saveDebounced();
    const snapshot = Object.entries(msg.reactionsRaw).map(([e, s]) => ({ emoji: e, users: [...s] }));
    io.emit("reaction-update", { msgId, reactions: snapshot });
  });

  socket.on("seen", ({ id }) => {
    const username = users[socket.id]?.name; if (!username) return;
    const msg = history.find(m => m.id === id);
    if (msg && !msg.seenBy.includes(username)) {
      msg.seenBy.push(username);
      io.emit("seen-update", { id, reader: username });
    }
  });

  socket.on("typing", () => {
    const username = users[socket.id]?.name;
    if (username) socket.broadcast.emit("typing", username);
  });

  socket.on("disconnect", () => {
    const username = users[socket.id]?.name;
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
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializeHistory()));
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles));
  } catch {}
  server.close(() => { log.info("closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
