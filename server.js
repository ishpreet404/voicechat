const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userName }) => {
    const safeRoomId = String(roomId || "lobby").trim().slice(0, 40) || "lobby";
    const safeUserName = String(userName || "Guest").trim().slice(0, 32) || "Guest";

    socket.data.roomId = safeRoomId;
    socket.data.userName = safeUserName;

    if (!rooms.has(safeRoomId)) {
      rooms.set(safeRoomId, new Map());
    }

    const room = rooms.get(safeRoomId);
    const participants = [...room.entries()].map(([id, user]) => ({
      id,
      userName: user.userName,
      muted: user.muted,
    }));

    room.set(socket.id, { userName: safeUserName, muted: false });
    socket.join(safeRoomId);

    socket.emit("room-participants", {
      roomId: safeRoomId,
      participants,
    });

    socket.to(safeRoomId).emit("peer-joined", {
      id: socket.id,
      userName: safeUserName,
      muted: false,
    });
  });

  socket.on("signal-offer", ({ to, offer }) => {
    io.to(to).emit("signal-offer", {
      from: socket.id,
      fromName: socket.data.userName,
      offer,
    });
  });

  socket.on("signal-answer", ({ to, answer }) => {
    io.to(to).emit("signal-answer", {
      from: socket.id,
      answer,
    });
  });

  socket.on("signal-ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("signal-ice-candidate", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("mute-state-changed", ({ muted }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    const participant = room.get(socket.id);
    if (participant) {
      participant.muted = Boolean(muted);
    }

    socket.to(roomId).emit("peer-mute-state", {
      id: socket.id,
      muted: Boolean(muted),
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.delete(socket.id);

    socket.to(roomId).emit("peer-left", {
      id: socket.id,
    });

    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice chat app is running on http://localhost:${PORT}`);
});
