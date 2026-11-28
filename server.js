const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret.json'), 'utf8'));

// Хранилище игроков и миров
const onlinePlayers = {}; // socket.id -> { nick, worldId, x, y, hasOctopus }
const nickToSocket = {};  // nick -> socket.id
const worlds = {};        // worldId -> { tiles: {}, unlockedZones: [], eventActive: false }

function getOrCreateWorld(worldId) {
  if (!worlds[worldId]) {
    const tiles = {};
    // Генерация стартового острова 20x20
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        let type = 'grass';
        if (x === 0 || x === 19 || y === 0 || y === 19) type = 'water';
        else if ((x === 4 && y === 4) || (x === 15 && y === 6) || (x === 7 && y === 14)) type = 'tree';
        tiles[`${x},${y}`] = { type, crop: null, stage: 0 };
      }
    }
    worlds[worldId] = {
      id: worldId,
      tiles,
      unlockedZones: ['main'],
      eventActive: false
    };
  }
  return worlds[worldId];
}

// API для проверки пароля админа
app.post('/api/auth-admin', (req, res) => {
  const { nick, password } = req.body;
  if (nick === secrets.adminNick && password === secrets.adminPassword) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'Неверный пароль администратора' });
});

io.on('connection', (socket) => {
  // Регистрация игрока
  socket.on('register', ({ nick, isAdmin }) => {
    onlinePlayers[socket.id] = {
      id: socket.id,
      nick,
      isAdmin: !!isAdmin,
      worldId: nick, // По умолчанию свой мир
      x: 10,
      y: 10,
      hasOctopus: false
    };
    nickToSocket[nick] = socket.id;
    socket.emit('registered', { nick, isAdmin: !!isAdmin });
  });

  // Смена ника
  socket.on('changeNick', (newNick) => {
    const player = onlinePlayers[socket.id];
    if (!player) return;
    delete nickToSocket[player.nick];
    player.nick = newNick;
    nickToSocket[newNick] = socket.id;
    io.to(player.worldId).emit('playerUpdated', player);
  });

  // Вход в мир (свой или друга)
  socket.on('joinWorld', (worldId) => {
    const player = onlinePlayers[socket.id];
    if (!player) return;

    if (player.worldId) socket.leave(player.worldId);
    player.worldId = worldId;
    player.x = 10;
    player.y = 10;
    socket.join(worldId);

    const world = getOrCreateWorld(worldId);
    socket.emit('worldState', world);

    // Отправляем список игроков в этом мире
    const playersInWorld = Object.values(onlinePlayers).filter(p => p.worldId === worldId);
    io.to(worldId).emit('playersList', playersInWorld);
  });

  // Приглашение игрока по нику
  socket.on('invitePlayer', (targetNick) => {
    const sender = onlinePlayers[socket.id];
    const targetSocketId = nickToSocket[targetNick];
    if (sender && targetSocketId) {
      io.to(targetSocketId).emit('receiveInvite', {
        fromNick: sender.nick,
        worldId: sender.worldId
      });
      socket.emit('notify', `Приглашение отправлено игроку ${targetNick}!`);
    } else {
      socket.emit('notify', `Игрок ${targetNick} не в сети.`);
    }
  });

  // Передвижение
  socket.on('move', ({ x, y, hasOctopus }) => {
    const player = onlinePlayers[socket.id];
    if (!player) return;
    player.x = x;
    player.y = y;
    if (hasOctopus !== undefined) player.hasOctopus = hasOctopus;
    socket.to(player.worldId).emit('playerMoved', player);
  });

  // Взаимодействие с тайлом (вспахать, посадить, полить, срубить, построить)
  socket.on('tileAction', ({ x, y, action, item }) => {
    const player = onlinePlayers[socket.id];
    if (!player) return;
    const world = getOrCreateWorld(player.worldId);
    const key = `${x},${y}`;
    const tile = world.tiles[key];
    if (!tile) return;

    if (action === 'plow' && tile.type === 'grass') {
      tile.type = 'soil';
    } else if (action === 'plant' && tile.type === 'soil' && !tile.crop) {
      tile.crop = item || 'carrot';
      tile.stage = 1;
    } else if (action === 'water' && tile.crop) {
      tile.stage = Math.min(3, tile.stage + 1);
    } else if (action === 'harvest' && tile.stage >= 3) {
      tile.crop = null;
      tile.stage = 0;
    } else if (action === 'chop' && tile.type === 'tree') {
      tile.type = 'grass';
    } else if (action === 'build' && tile.type === 'grass') {
      tile.type = item || 'fence';
    }

    io.to(player.worldId).emit('tileUpdated', { key, tile });
  });

  // АДМИН-ФУНКЦИИ (только для HELM77ZX)
  socket.on('adminAction', ({ type, targetNick, payload }) => {
    const admin = onlinePlayers[socket.id];
    if (!admin || !admin.isAdmin) return;

    const targetId = targetNick ? nickToSocket[targetNick] : socket.id;
    const targetPlayer = onlinePlayers[targetId];

    if (type === 'giveResources' && targetId) {
      io.to(targetId).emit('adminReward', { resource: payload.resource, amount: payload.amount });
    } else if (type === 'giveEnergy' && targetId) {
      io.to(targetId).emit('adminReward', { resource: 'energy', amount: payload.amount });
    } else if (type === 'unlockLocation' && targetPlayer) {
      const world = getOrCreateWorld(targetPlayer.worldId);
      if (!world.unlockedZones.includes(payload.zone)) {
        world.unlockedZones.push(payload.zone);
        // Расширяем землю вместо части воды
        for (let x = 1; x < 19; x++) {
          world.tiles[`${x},1`] = { type: 'grass', crop: null, stage: 0 };
        }
      }
      io.to(targetPlayer.worldId).emit('worldState', world);
    } else if (type === 'toggleEvent' && targetPlayer) {
      const world = getOrCreateWorld(targetPlayer.worldId);
      world.eventActive = !world.eventActive;
      io.to(targetPlayer.worldId).emit('eventStatus', world.eventActive);
    }
  });

  socket.on('disconnect', () => {
    const player = onlinePlayers[socket.id];
    if (player) {
      delete nickToSocket[player.nick];
      const worldId = player.worldId;
      delete onlinePlayers[socket.id];
      io.to(worldId).emit('playerLeft', socket.id);
    }
  });
});

const PORT = 4545;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер игры запущен на порту ${PORT}: http://103.82.102.226:${PORT}/`);
});
