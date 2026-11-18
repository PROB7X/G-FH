const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Раздаем index.html и остальные файлы из текущей папки
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 8080;
const players = {};

io.on('connection', (socket) => {
  console.log(`Подключился сокет: ${socket.id}`);

  socket.on('join_game', (nickname) => {
    const cleanNick = String(nickname || 'Player').trim().slice(0, 16);

    players[socket.id] = {
      id: socket.id,
      nickname: cleanNick,
      crystals: 100,
      grits: 5
    };

    socket.emit('player_data', players[socket.id]);
    io.emit('players_list', Object.values(players));
    console.log(`Игрок вошел: ${cleanNick}`);
  });

  socket.on('exchange_to_grits', () => {
    const player = players[socket.id];
    if (!player) return;

    const rate = 50;
    if (player.crystals >= rate) {
      player.crystals -= rate;
      player.grits += 1;
      socket.emit('player_data', player);
      io.emit('players_list', Object.values(players));
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      console.log(`Игрок вышел: ${players[socket.id].nickname}`);
      delete players[socket.id];
      io.emit('players_list', Object.values(players));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер GFT запущен на порту ${PORT}`);
});
