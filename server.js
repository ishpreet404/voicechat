const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CORS_ORIGIN || "*")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const originMatchers = allowedOrigins.map((origin) => {
	const normalized = normalizeOrigin(origin);

	if (normalized === "*") {
		return { type: "all" };
	}

	if (normalized.includes("*")) {
		const escaped = normalized
			.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*");
		return {
			type: "pattern",
			regex: new RegExp(`^${escaped}$`),
		};
	}

	return {
		type: "exact",
		value: normalized,
	};
});

function normalizeOrigin(value) {
	const raw = String(value || "").trim();
	if (!raw || raw === "*") {
		return raw;
	}

	try {
		return new URL(raw).origin.toLowerCase();
	} catch {
		return raw.replace(/\/+$/, "").toLowerCase();
	}
}

function isAllowedOrigin(origin) {
	if (!origin) {
		return true;
	}

	const normalizedOrigin = normalizeOrigin(origin);

	return originMatchers.some((matcher) => {
		if (matcher.type === "all") {
			return true;
		}

		if (matcher.type === "exact") {
			return matcher.value === normalizedOrigin;
		}

		return matcher.regex.test(normalizedOrigin);
	});
}

function getCorsOriginHeader(origin) {
	if (!origin || !isAllowedOrigin(origin)) {
		return "";
	}

	if (originMatchers.some((matcher) => matcher.type === "all")) {
		return "*";
	}

	return origin;
}

const io = new Server(server, {
	cors: {
		origin: (origin, callback) => {
			if (isAllowedOrigin(origin)) {
				callback(null, true);
				return;
			}

			callback(new Error("CORS origin is not allowed"), false);
		},
		methods: ["GET", "POST"],
	},
});

const KEEP_ALIVE_ENABLED =
	String(process.env.KEEP_ALIVE_ENABLED || "false") === "true";
const KEEP_ALIVE_INTERVAL_MS = Math.max(
	30_000,
	Number(process.env.KEEP_ALIVE_INTERVAL_MS || 14 * 60 * 1000),
);
const KEEP_ALIVE_URL = String(process.env.KEEP_ALIVE_URL || "").trim();
const TURN_URLS = (process.env.TURN_URLS || "")
	.split(",")
	.map((url) => url.trim())
	.filter(Boolean);
const TURN_USERNAME = String(process.env.TURN_USERNAME || "").trim();
const TURN_CREDENTIAL = String(process.env.TURN_CREDENTIAL || "").trim();
const TURN_HAS_USERNAME = Boolean(TURN_USERNAME);
const TURN_HAS_CREDENTIAL = Boolean(TURN_CREDENTIAL);
const TURN_HAS_FULL_CREDENTIALS = TURN_HAS_USERNAME && TURN_HAS_CREDENTIAL;
const TURN_HAS_PARTIAL_CREDENTIALS =
	(TURN_HAS_USERNAME && !TURN_HAS_CREDENTIAL) ||
	(!TURN_HAS_USERNAME && TURN_HAS_CREDENTIAL);
const DEFAULT_STUN_URLS = [
	"stun:stun.l.google.com:19302",
	"stun:stun1.l.google.com:19302",
	"stun:stun2.l.google.com:19302",
	"stun:stun3.l.google.com:19302",
];

if (TURN_URLS.length && TURN_HAS_PARTIAL_CREDENTIALS) {
	console.warn(
		"TURN_URLS has partial credentials. Provide both TURN_USERNAME and TURN_CREDENTIAL, or neither for no-auth TURN.",
	);
}

const rooms = new Map();
const roomMessages = new Map();
const ROOM_CHAT_HISTORY_LIMIT = 60;

function ensureRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, new Map());
	}

	return rooms.get(roomId);
}

function ensureRoomMessages(roomId) {
	if (!roomMessages.has(roomId)) {
		roomMessages.set(roomId, []);
	}

	return roomMessages.get(roomId);
}

function sanitizeChatMessage(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

function leaveCurrentRoom(socket, roomId) {
	if (!roomId || !rooms.has(roomId)) {
		return;
	}

	const room = rooms.get(roomId);
	if (!room.has(socket.id)) {
		return;
	}

	room.delete(socket.id);
	socket.leave(roomId);

	socket.to(roomId).emit("peer-left", {
		id: socket.id,
	});

	socket.to(roomId).emit("room-meta", {
		participantCount: room.size,
	});

	if (room.size === 0) {
		rooms.delete(roomId);
		roomMessages.delete(roomId);
	}
}

function isValidSignalTarget(roomId, targetSocketId) {
	if (!roomId || !rooms.has(roomId)) {
		return false;
	}

	return rooms.get(roomId).has(targetSocketId);
}

app.use((req, res, next) => {
	const requestOrigin = req.headers.origin;
	const corsOriginHeader = getCorsOriginHeader(requestOrigin);

	if (corsOriginHeader) {
		res.setHeader("Access-Control-Allow-Origin", corsOriginHeader);
		if (corsOriginHeader !== "*") {
			res.setHeader("Vary", "Origin");
		}
	}

	res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.status(204).end();
		return;
	}

	next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
	res.status(200).json({ ok: true });
});

app.get("/rtc-config", (_req, res) => {
	const iceServers = [{ urls: DEFAULT_STUN_URLS }];

	if (TURN_URLS.length) {
		const turnServer = {
			urls: TURN_URLS,
		};

		if (TURN_HAS_FULL_CREDENTIALS) {
			turnServer.username = TURN_USERNAME;
			turnServer.credential = TURN_CREDENTIAL;
		}

		iceServers.push(turnServer);
	}

	res.status(200).json({ iceServers });
});

function startKeepAliveClock(port) {
	if (!KEEP_ALIVE_ENABLED) {
		return;
	}

	const targetUrl = KEEP_ALIVE_URL || `http://127.0.0.1:${port}/health`;

	const tick = async () => {
		try {
			const response = await fetch(targetUrl, {
				method: "GET",
				cache: "no-store",
			});

			if (!response.ok) {
				console.warn(
					`Keep-alive ping failed with status ${response.status} at ${targetUrl}`,
				);
			}
		} catch (error) {
			console.warn(`Keep-alive ping error at ${targetUrl}: ${error.message}`);
		}
	};

	setInterval(tick, KEEP_ALIVE_INTERVAL_MS);
	console.log(
		`Keep-alive clock enabled. Pinging ${targetUrl} every ${Math.round(
			KEEP_ALIVE_INTERVAL_MS / 1000,
		)} seconds.`,
	);
}

io.on("connection", (socket) => {
	socket.on("join-room", ({ roomId, userName }) => {
		const safeRoomId =
			String(roomId || "lobby")
				.trim()
				.slice(0, 40) || "lobby";
		const safeUserName =
			String(userName || "Guest")
				.trim()
				.slice(0, 32) || "Guest";

		const previousRoomId = socket.data.roomId;
		if (previousRoomId && previousRoomId !== safeRoomId) {
			leaveCurrentRoom(socket, previousRoomId);
		}

		socket.data.roomId = safeRoomId;
		socket.data.userName = safeUserName;

		const room = ensureRoom(safeRoomId);
		const alreadyInRoom = room.has(socket.id);
		const participants = [...room.entries()]
			.filter(([id]) => id !== socket.id)
			.map(([id, user]) => ({
				id,
				userName: user.userName,
				muted: user.muted,
				sharing: user.sharing,
			}));

		room.set(socket.id, {
			userName: safeUserName,
			muted: false,
			sharing: false,
		});
		socket.join(safeRoomId);

		socket.emit("room-participants", {
			roomId: safeRoomId,
			participants,
		});

		socket.emit("chat-history", {
			messages: [...ensureRoomMessages(safeRoomId)],
		});

		socket.emit("room-meta", {
			participantCount: room.size,
		});

		if (!alreadyInRoom) {
			socket.to(safeRoomId).emit("peer-joined", {
				id: socket.id,
				userName: safeUserName,
				muted: false,
				sharing: false,
			});
		}

		socket.to(safeRoomId).emit("room-meta", {
			participantCount: room.size,
		});
	});

	socket.on("signal-offer", ({ to, offer }) => {
		const roomId = socket.data.roomId;
		if (!isValidSignalTarget(roomId, to)) {
			return;
		}

		io.to(to).emit("signal-offer", {
			from: socket.id,
			fromName: socket.data.userName,
			offer,
		});
	});

	socket.on("signal-answer", ({ to, answer }) => {
		const roomId = socket.data.roomId;
		if (!isValidSignalTarget(roomId, to)) {
			return;
		}

		io.to(to).emit("signal-answer", {
			from: socket.id,
			answer,
		});
	});

	socket.on("signal-ice-candidate", ({ to, candidate }) => {
		const roomId = socket.data.roomId;
		if (!isValidSignalTarget(roomId, to)) {
			return;
		}

		io.to(to).emit("signal-ice-candidate", {
			from: socket.id,
			candidate,
		});
	});

	socket.on("chat-message", ({ message }) => {
		const roomId = socket.data.roomId;
		if (!roomId || !rooms.has(roomId)) {
			return;
		}

		const safeMessage = sanitizeChatMessage(message);
		if (!safeMessage) {
			return;
		}

		const payload = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			fromId: socket.id,
			fromName: socket.data.userName || "Guest",
			message: safeMessage,
			at: Date.now(),
		};

		const messages = ensureRoomMessages(roomId);
		messages.push(payload);
		if (messages.length > ROOM_CHAT_HISTORY_LIMIT) {
			messages.splice(0, messages.length - ROOM_CHAT_HISTORY_LIMIT);
		}

		io.to(roomId).emit("chat-message", payload);
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

	socket.on("screen-share-state-changed", ({ sharing }) => {
		const roomId = socket.data.roomId;
		if (!roomId || !rooms.has(roomId)) {
			return;
		}

		const room = rooms.get(roomId);
		const participant = room.get(socket.id);
		if (participant) {
			participant.sharing = Boolean(sharing);
		}

		socket.to(roomId).emit("peer-screen-share-state", {
			id: socket.id,
			sharing: Boolean(sharing),
		});
	});

	socket.on("disconnect", () => {
		const roomId = socket.data.roomId;
		leaveCurrentRoom(socket, roomId);
	});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Voice chat app is running on http://localhost:${PORT}`);
	startKeepAliveClock(PORT);
});
