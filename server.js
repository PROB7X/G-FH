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
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret.json'), 'utf8'));

const onlinePlayers = {};
const nickToSocket = {};
const worlds = {};

const MAP_SIZE = 34;

function generateArchipelago() {
  const tiles = {};
  const islands = [
    { cx: 12, cy: 12, r: 7.5 }, // Главный стартовый остров
    { cx: 25, cy: 10, r: 5.5 }, // Восточный остров
    { cx: 16, cy: 25, r: 6.5 }  // Южный остров
  ];

  for (let x = 0; x < MAP_SIZE; x++) {
    for (let y = 0; y < MAP_SIZE; y++) {
      let isLand = false;
      for (const isl of islands) {
        const dist = Math.hypot(x - isl.cx, y - isl.cy);
        const noise = Math.sin(x * 0.7) * Math.cos(y * 0.7) * 1.1;
        if (dist + noise <= isl.r) {
          isLand = true;
          break;
        }
      }
      let type = isLand ? 'grass' : 'water';
      if (isLand && Math.random() < 0.14 && !(Math.abs(x - 12) <= 2 && Math.abs(y - 12) <= 2)) {
        type = 'tree';
      }
      tiles[`${x},${y}`] = { type, crop: null, stage: 0, buildProgress: 1, buildTarget: null };
    }
  }
  // Стол крафтов со старта рядом со спавном
  tiles['13,11'] = { type: 'workbench', crop: null, stage: 0, buildProgress: 1 };
  tiles['12,12'] = { type: 'path', crop: null, stage: 0, buildProgress: 1 };
  return tiles;
}

function getOrCreateWorld(worldId) {
  if (!worlds[worldId]) {
    worlds[worldId] = {
      id: worldId,
      size: MAP_SIZE,
      tiles: generateArchipelago(),
      eventActive: false
    };
  }
  return worlds[worldId];
}

// Периодический спавн 3D-деревьев (не появляются на тропинках и постройках)
setInterval(() => {
  Object.values(worlds).forEach(world => {
    const keys = Object.keys(world.tiles);
    const randKey = keys[Math.floor(Math.random() * keys.length)];
    const tile = world.tiles[randKey];
    if (tile && tile.type === 'grass' && !tile.crop && Math.random() < 0.35) {
      tile.type = 'tree';
      io.to(world.id).emit('tileUpdated', { key: randKey, tile });
    }
  });
}, 8000);

app.post('/api/auth-admin', (req, res) => {
  const { nick, password } = req.body;
  if (nick === secrets.adminNick && password === secrets.adminPassword) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

io.on('connection', (socket) => {
  socket.on('register', ({ nick, isAdmin }) => {
    onlinePlayers[socket.id] = {
      id: socket.id,
      nick,
      isAdmin: !!isAdmin,
      worldId: nick,
      x: 12,
      y: 12,
      targetX: 12,
      targetY: 12,
      inBoat: false,
      hasOctopus: false
    };
    nickToSocket[nick] = socket.id;
  });

  socket.on('changeNick', (newNick) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    delete nickToSocket[p.nick];
    p.nick = newNick;
    nickToSocket[newNick] = socket.id;
    io.to(p.worldId).emit('playerUpdated', p);
  });

  socket.on('joinWorld', (worldId) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    if (p.worldId) socket.leave(p.worldId);
    p.worldId = worldId;
    p.x = 12; p.y = 12; p.targetX = 12; p.targetY = 12;
    socket.join(worldId);

    const world = getOrCreateWorld(worldId);
    socket.emit('worldState', world);
    const list = Object.values(onlinePlayers).filter(pl => pl.worldId === worldId);
    io.to(worldId).emit('playersList', list);
  });

  socket.on('invitePlayer', (targetNick) => {
    const sender = onlinePlayers[socket.id];
    const targetId = nickToSocket[targetNick];
    if (sender && targetId) {
      io.to(targetId).emit('receiveInvite', { fromNick: sender.nick, worldId: sender.worldId });
      socket.emit('notify', `Приглашение отправлено: ${targetNick}`);
    } else {
      socket.emit('notify', `Игрок ${targetNick} не найден в сети`);
    }
  });

  // Передача только конечной точки маршрута (для плавного движения на клиенте)
  socket.on('moveTarget', ({ targetX, targetY, inBoat, hasOctopus }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.targetX = targetX;
    p.targetY = targetY;
    p.x = targetX;
    p.y = targetY;
    p.inBoat = !!inBoat;
    if (hasOctopus !== undefined) p.hasOctopus = hasOctopus;
    socket.to(p.worldId).emit('playerTarget', {
      id: p.id, targetX, targetY, inBoat: p.inBoat, hasOctopus: p.hasOctopus
    });
  });

  socket.on('tileAction', ({ x, y, action, item, buildTime }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    const world = getOrCreateWorld(p.worldId);
    const key = `${x},${y}`;
    const tile = world.tiles[key];
    if (!tile) return;

    if (action === 'path' && tile.type === 'grass') {
      tile.type = 'path';
    } else if (action === 'plow' && (tile.type === 'grass' || tile.type === 'path')) {
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
    } else if (action === 'build' && (tile.type === 'grass' || tile.type === 'water')) {
      tile.type = 'constructing';
      tile.buildTarget = item;
      tile.buildProgress = 0;
      io.to(p.worldId).emit('tileUpdated', { key, tile });

      // Постепенное строительство в 3D в зависимости от сложности здания
      const steps = 10;
      const stepMs = Math.max(200, (buildTime || 3000) / steps);
      let currentStep = 0;
      const timer = setInterval(() => {
        currentStep++;
        tile.buildProgress = currentStep / steps;
        if (currentStep >= steps) {
          clearInterval(timer);
          tile.type = tile.buildTarget;
          tile.buildProgress = 1;
        }
        io.to(p.worldId).emit('tileUpdated', { key, tile });
      }, stepMs);
      return;
    }

    io.to(p.worldId).emit('tileUpdated', { key, tile });
  });

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
      // Строим деревянный мост между главным и восточным островом
      for (let x = 18; x <= 21; x++) {
        world.tiles[`${x},11`] = { type: 'bridge', crop: null, stage: 0, buildProgress: 1 };
      }
      io.to(targetPlayer.worldId).emit('worldState', world);
    } else if (type === 'toggleEvent' && targetPlayer) {
      const world = getOrCreateWorld(targetPlayer.worldId);
      world.eventActive = !world.eventActive;
      io.to(targetPlayer.worldId).emit('eventStatus', world.eventActive);
    }
  });

  socket.on('disconnect', () => {
    const p = onlinePlayers[socket.id];
    if (p) {
      delete nickToSocket[p.nick];
      const wid = p.worldId;
      delete onlinePlayers[socket.id];
      io.to(wid).emit('playerLeft', socket.id);
    }
  });
});

const PORT = 4545;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}: http://103.82.102.226:${PORT}/`);
});
