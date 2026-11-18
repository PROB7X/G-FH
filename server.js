const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 8080;

// Хранилище игроков онлайн и их профилей
const players = {};

app.get('/', (req, res) => {
  res.send('GFT Server is running on port 8080');
});

io.on('connection', (socket) => {
  console.log(`Подключился сокет: ${socket.id}`);

  // Регистрация/вход игрока по нику
  socket.on('join_game', (nickname) => {
    const cleanNick = String(nickname || 'Player').trim().slice(0, 16);

    players[socket.id] = {
      id: socket.id,
      nickname: cleanNick,
      crystals: 100, // Стартовый баланс кристаллов
      grits: 5       // Стартовый баланс гритсов (более редкая/дорогая валюта)
    };

    // Отправляем игроку его данные
    socket.emit('player_data', players[socket.id]);

    // Рассылаем всем обновленный список игроков онлайн (для других игроков и админов)
    io.emit('players_list', Object.values(players));
    console.log(`Игрок вошел: ${cleanNick}`);
  });

  // Пример обмена кристаллов на гритсы (например, 50 кристаллов = 1 гритс)
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
