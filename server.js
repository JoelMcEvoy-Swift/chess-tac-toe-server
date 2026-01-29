import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // OK for testing; restrict later
  }
});

// In-memory rooms
// roomCode -> { hostId, players: [socketId...], roles: { [socketId]: "white"|"black" } }
const rooms = {};

function makeCode(len = 4) {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function getRoomOfSocket(socketId) {
  for (const code of Object.keys(rooms)) {
    if (rooms[code].players.includes(socketId)) return code;
  }
  return null;
}

function swapRoomRoles(code) {
  const room = rooms[code];
  if (!room) return null;

  const ids = room.players.slice();
  if (ids.length !== 2) return null;

  const [a, b] = ids;
  room.roles[a] = room.roles[a] === "white" ? "black" : "white";
  room.roles[b] = room.roles[b] === "white" ? "black" : "white";

  return room.roles;
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("create-room", () => {
    // generate unique code (simple retry loop)
    let code = makeCode(4);
    while (rooms[code]) code = makeCode(4);

    rooms[code] = {
      hostId: socket.id,
      players: [socket.id],
      roles: { [socket.id]: "white" } // host = white
    };

    socket.join(code);

    socket.emit("room-created", { roomCode: code, role: "white" });
    console.log(`Room ${code} created by ${socket.id} (white)`);
  });

  socket.on("join-room", (code) => {
    code = String(code || "").trim().toUpperCase();

    if (!rooms[code] || rooms[code].players.length >= 2) {
      socket.emit("room-error", "Room unavailable");
      return;
    }

    rooms[code].players.push(socket.id);
    rooms[code].roles[socket.id] = "black"; // joiner = black

    socket.join(code);

    // Tell joiner their role
    socket.emit("room-joined", { roomCode: code, role: "black" });

    // Tell host that opponent joined (optional)
    io.to(rooms[code].hostId).emit("opponent-joined", { roomCode: code });

    // Notify both players game can start
    io.to(code).emit("room-ready", {
      roomCode: code,
      roles: rooms[code].roles
    });

    console.log(`Room ${code} ready: ${rooms[code].players.join(", ")}`);
  });

  socket.on("action", ({ roomCode, action }) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    if (!rooms[roomCode]) return;

    // ensure sender is in the room
    if (!rooms[roomCode].players.includes(socket.id)) return;

    // Server-handled action: swap sides (and restart)
    if (action?.type === "swap-sides") {
      const roles = swapRoomRoles(roomCode);
      if (!roles) {
        io.to(socket.id).emit("room-error", "Need 2 players to swap sides");
        return;
      }

      // Tell everyone the new roles
      io.to(roomCode).emit("roles-updated", { roomCode, roles });

      // Restart both clients after swap (keeps things simple)
      io.to(roomCode).emit("action", { type: "restart" });
      return;
    }

    // Default: broadcast to BOTH players (including sender)
    io.to(roomCode).emit("action", action);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    const code = getRoomOfSocket(socket.id);
    if (!code) return;

    // Remove player
    rooms[code].players = rooms[code].players.filter(p => p !== socket.id);
    delete rooms[code].roles[socket.id];

    // Notify remaining player (if any)
    socket.to(code).emit("opponent-left", { roomCode: code });

    // If empty, delete room
    if (rooms[code].players.length === 0) {
      delete rooms[code];
      console.log(`Room ${code} deleted (empty).`);
    } else {
      // If host left, promote remaining player to host (optional)
      if (rooms[code].hostId === socket.id) {
        rooms[code].hostId = rooms[code].players[0];
      }
      console.log(`Room ${code} now has: ${rooms[code].players.join(", ")}`);
    }
  });
});

server.listen(3000, () => {
  console.log("Socket.IO server running on http://localhost:3000");
});
