const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Загрузка секретного пароля
let secretConfig = { ownerPassword: "admin" };
try {
    if (fs.existsSync('./secret.json')) {
        secretConfig = JSON.parse(fs.readFileSync('./secret.json', 'utf8'));
    }
} catch (e) {
    console.error("Ошибка чтения secret.json:", e);
}

// Единая база данных игроков (в памяти, можно подключить JSON/SQLite)
const globalPlayersDB = {}; 
// Активные подключения: socket.id -> данные
const activeSockets = {};
// Список серверов
const serversList = {
    "play.ribalka.hu": { name: "play.ribalka.hu", owner: "System", players: 0 }
};

function getOrCreatePlayer(nick) {
    if (!globalPlayersDB[nick]) {
        globalPlayersDB[nick] = {
            nick: nick,
            level: nick === "HELM77ZX" ? 150 : 1,
            xp: 0,
            coins: nick === "HELM77ZX" ? 999999 : 100,
            isOwner: nick === "HELM77ZX",
            inventory: [],
            enderChest: [],
            gear: {
                rod: { name: "Деревянная удочка", power: 1.0, maxWeight: 15 },
                line: { name: "Обычная леска", strength: 15 },
                reel: { name: "Простой моток", speed: 1.0 },
                bait: { name: "Червяк", luck: 1.0 },
                bobber: { name: "Красный поплавок", stability: 1.0 }
            }
        };
    }
    return globalPlayersDB[nick];
}

io.on('connection', (socket) => {
    // Отправка списка серверов
    socket.emit('servers_list', Object.values(serversList));

    // Проверка ника перед входом
    socket.on('check_nick', ({ nick }) => {
        if (nick === "HELM77ZX") {
            socket.emit('require_owner_password');
        } else {
            socket.emit('nick_approved', { isOwner: false });
        }
    });

    // Проверка пароля для HELM77ZX
    socket.on('verify_owner_password', ({ password }) => {
        if (password === secretConfig.ownerPassword) {
            socket.emit('nick_approved', { isOwner: true });
        } else {
            socket.emit('auth_error', 'Неверный пароль из secret.json!');
        }
    });

    // Создание кастомного сервера после 2 реклам
    socket.on('create_custom_server', ({ serverName, creatorNick }) => {
        const cleanName = serverName.trim() || `Server_${Math.floor(Math.random()*1000)}`;
        if (!serversList[cleanName]) {
            serversList[cleanName] = { name: cleanName, owner: creatorNick, players: 0 };
            io.emit('servers_list', Object.values(serversList));
        }
        socket.emit('server_created', cleanName);
    });

    // Вход на конкретный сервер (комнату)
    socket.on('join_server', ({ nick, serverName, isOwner }) => {
        if (nick === "HELM77ZX" && !isOwner) return; // Защита от подмены

        const playerData = getOrCreatePlayer(nick);
        const room = serversList[serverName] ? serverName : "play.ribalka.hu";
        
        socket.join(room);
        serversList[room].players++;

        activeSockets[socket.id] = {
            id: socket.id,
            nick: nick,
            room: room,
            x: 350, // Спавн правее эндер-сундука
            y: 360,
            vx: 0,
            facing: 1,
            location: 'water', // 'water' или 'lava'
            isOwner: playerData.isOwner,
            level: playerData.level,
            fishingState: 'idle' // idle, casting, waiting, minigame
        };

        // Отправляем игроку его единый профиль
        socket.emit('init_player', {
            self: activeSockets[socket.id],
            profile: playerData
        });

        // Уведомляем комнату о новом игроке
        socket.to(room).emit('player_joined', activeSockets[socket.id]);

        // Отправляем игроку список тех, кто уже в этой комнате
        const roomPlayers = {};
        for (let id in activeSockets) {
            if (activeSockets[id].room === room) {
                roomPlayers[id] = activeSockets[id];
            }
        }
        socket.emit('room_players', roomPlayers);
        io.emit('servers_list', Object.values(serversList));
    });

    // Движение и смена локации
    socket.on('player_move', (data) => {
        const p = activeSockets[socket.id];
        if (!p) return;
        p.x = data.x;
        p.y = data.y;
        p.facing = data.facing;
        p.location = data.location;
        p.fishingState = data.fishingState;
        socket.to(p.room).emit('player_moved', p);
    });

    // Сохранение улова, опыта и инвентаря
    socket.on('catch_fish', ({ fish, xpGain }) => {
        const p = activeSockets[socket.id];
        if (!p) return;
        const dbUser = globalPlayersDB[p.nick];
        if (!dbUser) return;

        dbUser.inventory.push(fish);
        dbUser.xp += xpGain;
        
        // Повышение уровня (каждые 100 XP)
        const newLevel = Math.floor(dbUser.xp / 100) + 1;
        if (newLevel > dbUser.level) {
            dbUser.level = newLevel;
            p.level = newLevel;
        }

        socket.emit('profile_updated', dbUser);
        socket.to(p.room).emit('player_moved', p);
    });

    // Синхронизация инвентаря и Эндер-сундука
    socket.on('sync_storage', ({ inventory, enderChest, gear }) => {
        const p = activeSockets[socket.id];
        if (!p) return;
        const dbUser = globalPlayersDB[p.nick];
        if (dbUser) {
            dbUser.inventory = inventory;
            dbUser.enderChest = enderChest;
            dbUser.gear = gear;
        }
    });

    // Система трейдов (20+ уровень)
    socket.on('trade_request', ({ targetId }) => {
        const sender = activeSockets[socket.id];
        const target = activeSockets[targetId];
        if (!sender || !target) return;

        if (sender.level < 20 || target.level < 20) {
            socket.emit('chat_msg', { sys: true, text: "Трейд доступен только игрокам 20+ уровня!" });
            return;
        }
        io.to(targetId).emit('incoming_trade', { fromId: socket.id, fromNick: sender.nick });
    });

    socket.on('trade_accept', ({ fromId, itemIndex }) => {
        const receiver = activeSockets[socket.id];
        const sender = activeSockets[fromId];
        if (!receiver || !sender) return;

        const senderDB = globalPlayersDB[sender.nick];
        const receiverDB = globalPlayersDB[receiver.nick];

        if (senderDB.inventory[itemIndex]) {
            const item = senderDB.inventory.splice(itemIndex, 1)[0];
            receiverDB.inventory.push(item);
            io.to(fromId).emit('profile_updated', senderDB);
            io.to(socket.id).emit('profile_updated', receiverDB);
            io.to(fromId).emit('chat_msg', { sys: true, text: `Вы передали ${item.name} игроку ${receiver.nick}` });
            io.to(socket.id).emit('chat_msg', { sys: true, text: `Вы получили ${item.name} от ${sender.nick}` });
        }
    });

    // Админ-команды для HELM77ZX
    socket.on('admin_command', ({ cmd, value }) => {
        const p = activeSockets[socket.id];
        if (!p || !p.isOwner) return;
        const dbUser = globalPlayersDB[p.nick];

        if (cmd === 'set_level') {
            dbUser.level = parseInt(value) || 100;
            dbUser.xp = (dbUser.level - 1) * 100;
            p.level = dbUser.level;
            socket.emit('profile_updated', dbUser);
        } else if (cmd === 'give_god_rod') {
            dbUser.gear.rod = { name: "Божественный спиннинг HELM", power: 5.0, maxWeight: 99999 };
            dbUser.gear.line = { name: "Титановая нить", strength: 99999 };
            socket.emit('profile_updated', dbUser);
        } else if (cmd === 'announce') {
            io.emit('chat_msg', { sys: true, text: `[OWNER HELM77ZX]: ${value}` });
        }
    });

    socket.on('disconnect', () => {
        const p = activeSockets[socket.id];
        if (p) {
            if (serversList[p.room]) {
                serversList[p.room].players = Math.max(0, serversList[p.room].players - 1);
            }
            socket.to(p.room).emit('player_left', socket.id);
            delete activeSockets[socket.id];
            io.emit('servers_list', Object.values(serversList));
        }
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер рыбалки запущен на порту ${PORT}`);
});
