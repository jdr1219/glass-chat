const express = require("express");
const http    = require("http");
const path    = require("path");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

const users   = {};
const history = [];
const MAX_HISTORY = 100;

io.on("connection", socket => {
  socket.on("join", username => {
    users[socket.id] = username;
    socket.emit("history", history);
    socket.broadcast.emit("system", `${username} joined`);
    io.emit("user-count", Object.keys(users).length);
  });

  socket.on("message", data => {
    const msg = {
      ...data,
      socketId: socket.id,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      seenBy: []
    };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit("message", msg);
  });

  socket.on("seen", ({ id, reader }) => {
    const msg = history.find(m => m.id === id);
    if (msg && !msg.seenBy.includes(reader)) {
      msg.seenBy.push(reader);
      io.emit("seen-update", { id, reader });
    }
  });

  socket.on("typing", username => {
    socket.broadcast.emit("typing", username);
  });

  socket.on("disconnect", () => {
    const username = users[socket.id];
    delete users[socket.id];
    if (username) {
      io.emit("system", `${username} left`);
      io.emit("user-count", Object.keys(users).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Glass Chat running on port ${PORT}`));
