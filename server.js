// npm install express socket.io bcrypt express-rate-limit
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");

// multer with memory storage for temporary files
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
// Only trust X-Forwarded-For when the request itself arrives from loopback (our own reverse proxy).
app.set("trust proxy", "loopback");
const server = http.createServer(app);
const io = new Server(server);

// In-memory store for rooms
const rooms = {};
// In-memory store for shared files
// fileId -> { roomId, name, buffer, timeout }
const files = new Map();
const MAX_CONNECTIONS_PER_IP = 10; // Prevent DDoS: max clients per IP per room
const SALT_ROUNDS = 10; // bcrypt cost factor

// Chat configuration and sanitization utilities
const MAX_CHAT_LENGTH = 1024; // max characters per chat message
const MAX_NAME_LENGTH = 32; // max characters for display name
// Basic per-socket message rate limiting (sliding window)
const CHAT_RATE_WINDOW_MS = 2 * 1000; // 2s
const CHAT_MAX_PER_WINDOW = 100; // max messages per window

function emitRoomPresence(roomId) {
    const room = rooms[roomId];
    if (room) io.to(roomId).emit("room-presence", { count: room.clients.size });
}

// Sends an ack (if provided) and a "server-error" event, optionally disconnecting the socket.
function sendServerError(socket, ack, message, disconnect = false) {
    if (ack) ack({ ok: false, error: message });
    socket.emit("server-error", message);
    if (disconnect) socket.disconnect(true);
}

function sanitizeMessage(input) {
    if (typeof input !== "string") return "";
    // normalize newlines, trim leading/trailing whitespace
    let msg = input.replace(/\r\n|\r/g, "\n").trim();

    // remove control characters except newline and tab
    msg = msg.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, "");

    // enforce max length
    if (msg.length > MAX_CHAT_LENGTH) {
        msg = msg.slice(0, MAX_CHAT_LENGTH);
    }

    // Note: not HTML-escaped here; the client renders messages via textContent, not innerHTML.
    return msg;
}

function sanitizeName(input) {
    if (typeof input !== "string") return "";
    let name = input.replace(/[\r\n]/g, " ").trim();
    // remove control characters
    name = name.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, "");
    if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);
    return name;
}

const MAX_FILENAME_LENGTH = 255;
function sanitizeFileName(input) {
    if (typeof input !== "string") return "file";
    // strip control/newline characters to prevent header injection via Content-Disposition
    let name = input.replace(/[\x00-\x1F\x7F]+/g, "").trim();
    if (name.length > MAX_FILENAME_LENGTH) name = name.slice(0, MAX_FILENAME_LENGTH);
    return name || "file";
}

// Global rate limiter: max 20 requests per IP per minute
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    handler: (req, res) => {
        const msg = "Too many requests from this IP, try again later.";
        if (req.accepts && req.accepts("json")) return res.status(429).json({ error: msg });
        return res.status(429).type("text").send(msg);
    }
});
app.use(globalLimiter);

// Specific limiter for creating rooms: max 3 per IP per minute
const createLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    handler: (req, res) => {
        const msg = "Too many create requests from this IP, try again later.";
        if (req.accepts && req.accepts("json")) return res.status(429).json({ error: msg });
        return res.status(429).type("text").send(msg);
    }
});

// Middleware for JSON parsing
app.use(express.json());

// Serve static files (index.html, etc.)
app.use(express.static("public"));

// Endpoint for uploading a file to a room (multipart/form-data field 'file')
// The file is stored in memory and expires 30 minutes after upload.
app.post("/upload/:roomId", async (req, res, next) => {
    const { roomId } = req.params;
    if (!rooms[roomId]) {
        return res.status(404).json({ error: "Room not found" });
    }
    // use multer to parse form-data
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File too large' });
            }
            return res.status(500).json({ error: 'Upload error' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Missing file' });
        }
        const id = crypto.randomBytes(8).toString('hex');
        const name = sanitizeFileName(req.file.originalname);
        const timeout = setTimeout(() => cleanupFile(id), 30 * 60 * 1000); // 30 minutes
        files.set(id, { roomId, name, buffer: req.file.buffer, timeout });
        // notify room members
        io.to(roomId).emit('file-shared', { fileId: id, name, size: req.file.size });
        res.json({ success: true, fileId: id, name, size: req.file.size });
    });
});

// Download endpoint for files
app.get('/download/:fileId', (req, res) => {
    const { fileId } = req.params;
    const info = files.get(fileId);
    if (!info) {
        return res.status(404).send('File not found or expired');
    }
    // We won't enforce room membership on HTTP request, since client could request directly.
    // Additional checks (e.g. token) could be added if desired.
    res.setHeader('Content-Disposition', `attachment; filename="${info.name.replace(/"/g,'') }"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(info.buffer);
});

// Endpoint for creating a room
app.post("/create/:roomId", createLimiter, async (req, res) => {
    const { roomId } = req.params;
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: "Password required" });
    }
    if (rooms[roomId]) {
        // allow recreation if the room exists but has no active socket connections
        const existing = rooms[roomId];

        // check whether any of the recorded client socket ids are still connected
        const hasActive = Array.from(existing.clients.keys()).some(socketId => {
            return Boolean(io.sockets.sockets.get && io.sockets.sockets.get(socketId));
        });

        if (existing.clients && existing.clients.size === 0 || !hasActive) {
            // stale / empty room: remove it and allow new creation
            delete rooms[roomId];
            // fall through to create new room
        } else {
            return res.status(400).json({ error: "Room already exists" });
        }
    }

    try {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        rooms[roomId] = {
            passwordHash,
            clients: new Map(), // socketId -> IP
            names: new Map(),   // socketId -> displayName
            streams: new Map(), // streamId -> { socketId, name }
            createdAt: Date.now()
        };
        return res.json({ success: true, roomId });
    } catch (err) {
        console.error("Hashing failed:", err);
        return res.status(500).json({ error: "Internal error" });
    }
});

// Cleanup helper
function cleanupRoom(roomId) {
	if (rooms[roomId]) {
		delete rooms[roomId];
		console.log(`Room ${roomId} cleaned up`);
	}
	// also purge any files associated with this room
	for (const [id, info] of files.entries()) {
		if (info.roomId === roomId) {
			cleanupFile(id);
		}
	}
}

// Cleanup helper for files
function cleanupFile(fileId) {
	const info = files.get(fileId);
	if (info) {
		clearTimeout(info.timeout);
		files.delete(fileId);
		console.log(`File ${fileId} removed (expired)`);
	}
}

// Engine.IO doesn't share Express's "trust proxy" setting, so resolve the real client IP
// ourselves: only trust X-Forwarded-For when the socket itself connected from loopback.
function resolveClientIp(req) {
    const remote = req.socket.remoteAddress;
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const xff = req.headers["x-forwarded-for"];
    if (isLoopback && xff) return xff.split(",")[0].trim();
    return remote;
}

// Socket.IO handling
io.on("connection", (socket) => {
    const ip = resolveClientIp(socket.request);
    console.log(`New client connected from ${ip}`);

    // per-socket chat timestamps for simple rate limiting
    socket._chatTimestamps = [];

    socket.on("join", async ({ roomId, password, displayName } = {}, callback) => {
        // support optional callback ack
        const ack = typeof callback === "function" ? callback : null;

        const room = rooms[roomId];
        if (!room) return sendServerError(socket, ack, "Invalid room/password");

        // Prevent duplicate joins
        if (room.clients.has(socket.id)) {
            const warn = "Already joined this room";
            if (ack) ack({ ok: false, error: warn });
            socket.emit("warning", warn);
            return;
        }

        try {
            const valid = await bcrypt.compare(password, room.passwordHash);
            if (!valid) return sendServerError(socket, ack, "Invalid room/password", true);
        } catch (err) {
            console.error("Password check failed:", err);
            return sendServerError(socket, ack, "Internal error", true);
        }

        // Enforce per-IP connection limit
        const ipCount = Array.from(room.clients.values())
            .filter(addr => addr === ip).length;

        if (ipCount >= MAX_CONNECTIONS_PER_IP) {
            return sendServerError(socket, ack, "Too many connections from your IP in this room", true);
        }

        // Register the client. Existing members initiate connections to newcomers.
        room.clients.set(socket.id, ip);
        // store sanitized display name (fallback to socket id truncated)
        const sname = sanitizeName(displayName) || socket.id;
        room.names.set(socket.id, sname);

        socket.join(roomId);
        socket.to(roomId).emit("peer-joined", socket.id);
        emitRoomPresence(roomId);

        for (const [streamId, stream] of room.streams) {
            socket.emit("stream-event", { from: stream.socketId, name: stream.name, streamId, type: "stream-start" });
        }

        if (ack) ack({ ok: true, roomId });
    });

    socket.on("signal", ({ roomId, data, target }) => {
        const room = rooms[roomId];
        if (!room || !room.clients.has(socket.id)) return; // not in room

        if (target && room.clients.has(target)) {
            io.to(target).emit("signal", { from: socket.id, data });
        } else {
            socket.to(roomId).emit("signal", { from: socket.id, data });
        }
    });

    socket.on("stream-event", ({ roomId, type, streamId } = {}) => {
        const room = rooms[roomId];
        if (!room || !room.clients.has(socket.id)) return;
        if (!["stream-start", "stream-stop"].includes(type) || typeof streamId !== "string") return;
        if (type === "stream-start") {
            room.streams.set(streamId, { socketId: socket.id, name: room.names.get(socket.id) || socket.id });
        } else {
            room.streams.delete(streamId);
        }
        socket.to(roomId).emit("stream-event", {
            from: socket.id,
            name: room.names.get(socket.id) || socket.id,
            streamId,
            type
        });
    });

    // Chat handler: sanitized, length-restricted, basic rate limiting
    socket.on("chat", ({ roomId, message, target } = {}, callback) => {
        const ack = typeof callback === "function" ? callback : null;
        const room = rooms[roomId];

        if (!room || !room.clients.has(socket.id)) return sendServerError(socket, ack, "Not in room");

        // basic per-socket rate limiting
        const now = Date.now();
        const timestamps = socket._chatTimestamps || [];
        // remove old entries
        while (timestamps.length && (now - timestamps[0]) > CHAT_RATE_WINDOW_MS) {
            timestamps.shift();
        }
        if (timestamps.length >= CHAT_MAX_PER_WINDOW) {
            return sendServerError(socket, ack, "Too many messages, slow down");
        }
        timestamps.push(now);
        socket._chatTimestamps = timestamps;

        const clean = sanitizeMessage(message);
        if (!clean) {
            const err = "Empty or invalid message";
            if (ack) ack({ ok: false, error: err });
            return;
        }

        const payload = {
            from: socket.id,
            name: room.names.get(socket.id) || socket.id,
            message: clean,
            time: Date.now()
        };

        if (target && room.clients.has(target)) {
            io.to(target).emit("chat", payload);
            if (ack) ack({ ok: true, private: true });
        } else {
            // broadcast to everyone in room (including sender)
            io.to(roomId).emit("chat", payload);
            if (ack) ack({ ok: true, private: false });
        }
    });

    socket.on("disconnect", () => {
        console.log(`Client from ${ip} disconnected`);
        for (const roomId in rooms) {
            if (rooms[roomId].clients.has(socket.id)) {
                rooms[roomId].clients.delete(socket.id);
                rooms[roomId].names.delete(socket.id);
                for (const [streamId, stream] of rooms[roomId].streams) {
                    if (stream.socketId === socket.id) {
                        rooms[roomId].streams.delete(streamId);
                        socket.to(roomId).emit("stream-event", { from: socket.id, name: stream.name, streamId, type: "stream-stop" });
                    }
                }
                socket.to(roomId).emit("peer-left", socket.id);
                emitRoomPresence(roomId);
                if (rooms[roomId].clients.size === 0) {
                    setTimeout(() => {
                        if (rooms[roomId] && rooms[roomId].clients.size === 0) {
                            cleanupRoom(roomId);
                        }
                    }, 5 * 60 * 1000); // 5-minutes grace period for reconnect
                }
            }
        }
    });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
