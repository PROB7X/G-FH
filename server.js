const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Загрузка secret.json
let secretConfig = { adminNick: "HELM77ZX", adminPassword: "admin" };
try {
    const raw = fs.readFileSync(path.join(__dirname, 'secret.json'), 'utf8');
    secretConfig = JSON.parse(raw);
} catch (e) {
    console.warn("⚠️ Файл secret.json не найден, используются стандартные настройки.");
}

const users = new Map(); // socket.id -> { id, nick, isAdmin }
const activeStreams = new Map(); // streamId -> { id, title, author, isAdmin }
const bannedNicks = new Set();

// Авторизация / Проверка ника
app.post('/api/auth', (req, res) => {
    const { nick, password } = req.body;
    if (!nick || nick.trim().length < 2) {
        return res.status(400).json({ ok: false, error: "Ник слишком короткий" });
    }

    const cleanNick = nick.trim();

    if (bannedNicks.has(cleanNick.toLowerCase())) {
        return res.status(403).json({ ok: false, error: "Этот ник заблокирован администратором" });
    }

    // Проверка зарезервированного ника HELM77ZX
    if (cleanNick.toUpperCase() === secretConfig.adminNick.toUpperCase()) {
        if (!password) {
            return res.json({ ok: false, requirePassword: true, error: "Ник защищен. Введите пароль из secret.json" });
        }
        if (password !== secretConfig.adminPassword) {
            return res.status(403).json({ ok: false, requirePassword: true, error: "Неверный пароль администратора!" });
        }
        return res.json({ ok: true, nick: secretConfig.adminNick, isAdmin: true });
    }

    return res.json({ ok: true, nick: cleanNick, isAdmin: false });
});

// WebSocket логика
io.on('connection', (socket) => {
    socket.emit('streams:update', Array.from(activeStreams.values()));

    socket.on('user:register', ({ nick, isAdmin }) => {
        users.set(socket.id, { id: socket.id, nick, isAdmin });
        broadcastAdminState();
    });

    socket.on('stream:start', ({ title }) => {
        const user = users.get(socket.id);
        if (!user) return;

        const stream = {
            id: socket.id,
            title: title || `Стрим от ${user.nick}`,
            author: user.nick,
            isAdmin: user.isAdmin
        };
        activeStreams.set(socket.id, stream);
        io.emit('streams:update', Array.from(activeStreams.values()));
        broadcastAdminState();
    });

    socket.on('stream:stop', () => {
        if (activeStreams.has(socket.id)) {
            activeStreams.delete(socket.id);
            io.emit('streams:update', Array.from(activeStreams.values()));
            broadcastAdminState();
        }
    });

    socket.on('chat:message', ({ streamId, text }) => {
        const user = users.get(socket.id);
        if (!user || !text.trim()) return;

        io.emit('chat:new', {
            streamId,
            author: user.nick,
            isAdmin: user.isAdmin,
            text: text.trim().slice(0, 200)
        });
    });

    // --- АДМИН КОМАНДЫ (из widjet.html) ---
    socket.on('admin:auth', ({ password }, callback) => {
        if (password === secretConfig.adminPassword) {
            socket.join('admins');
            callback({ ok: true });
            broadcastAdminState();
        } else {
            callback({ ok: false, error: "Неверный пароль" });
        }
    });

    socket.on('admin:stopStream', ({ streamId }) => {
        if (!socket.rooms.has('admins')) return;
        activeStreams.delete(streamId);
        io.to(streamId).emit('force:stopStream', "Ваш стрим принудительно завершен администратором.");
        io.emit('streams:update', Array.from(activeStreams.values()));
        broadcastAdminState();
    });

    socket.on('admin:banUser', ({ targetNick }) => {
        if (!socket.rooms.has('admins') || !targetNick) return;
        bannedNicks.add(targetNick.toLowerCase());
        
        for (const [id, u] of users.entries()) {
            if (u.nick.toLowerCase() === targetNick.toLowerCase()) {
                io.to(id).emit('force:ban', "Вы заблокированы администратором.");
                activeStreams.delete(id);
            }
        }
        io.emit('streams:update', Array.from(activeStreams.values()));
        broadcastAdminState();
    });

    socket.on('disconnect', () => {
        users.delete(socket.id);
        if (activeStreams.has(socket.id)) {
            activeStreams.delete(socket.id);
            io.emit('streams:update', Array.from(activeStreams.values()));
        }
        broadcastAdminState();
    });
});

function broadcastAdminState() {
    io.to('admins').emit('admin:state', {
        usersCount: users.size,
        users: Array.from(users.values()),
        streams: Array.from(activeStreams.values()),
        banned: Array.from(bannedNicks)
    });
}

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на http://0.0.0:${PORT}`);
});
