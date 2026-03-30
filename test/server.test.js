const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { io } = require("socket.io-client");

const workspaceRoot = path.resolve(__dirname, "..");
const testPort = 4300 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${testPort}`;

let serverProcess;
const serverLogs = [];

function wait(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForServer(timeoutMs = 10_000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
			if (response.ok) {
				return;
			}
		} catch {
			// Keep retrying until timeout.
		}

		await wait(150);
	}

	throw new Error(
		`Server did not start in ${timeoutMs}ms. Logs:\n${serverLogs.join("")}`,
	);
}

function onceEvent(socket, eventName, timeoutMs = 5_000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off(eventName, onEvent);
			reject(new Error(`Timed out waiting for event: ${eventName}`));
		}, timeoutMs);

		const onEvent = (payload) => {
			clearTimeout(timeout);
			socket.off(eventName, onEvent);
			resolve(payload);
		};

		socket.on(eventName, onEvent);
	});
}

async function connectClient() {
	const socket = io(baseUrl, {
		transports: ["websocket"],
		reconnection: false,
		timeout: 5_000,
	});

	await onceEvent(socket, "connect");
	return socket;
}

async function joinRoom(socket, roomId, userName) {
	const participantsPromise = onceEvent(socket, "room-participants");
	socket.emit("join-room", { roomId, userName });
	return participantsPromise;
}

async function disconnectClient(socket) {
	if (!socket) {
		return;
	}

	if (!socket.connected) {
		socket.close();
		return;
	}

	await new Promise((resolve) => {
		socket.once("disconnect", resolve);
		socket.disconnect();
	});
}

test.before(async () => {
	serverProcess = spawn(process.execPath, ["server.js"], {
		cwd: workspaceRoot,
		env: {
			...process.env,
			PORT: String(testPort),
			KEEP_ALIVE_ENABLED: "false",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	serverProcess.stdout.on("data", (chunk) => {
		serverLogs.push(chunk.toString());
	});

	serverProcess.stderr.on("data", (chunk) => {
		serverLogs.push(chunk.toString());
	});

	await waitForServer();
});

test.after(async () => {
	if (!serverProcess || serverProcess.exitCode !== null) {
		return;
	}

	serverProcess.kill();
	await new Promise((resolve) => {
		serverProcess.once("exit", resolve);
	});
});

test("health endpoint reports ok", async () => {
	const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.equal(payload.ok, true);
});

test("rtc-config includes multiple STUN URLs", async () => {
	const response = await fetch(`${baseUrl}/rtc-config`, { cache: "no-store" });
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.ok(Array.isArray(payload.iceServers));
	assert.ok(payload.iceServers.length >= 1);
	assert.ok(Array.isArray(payload.iceServers[0].urls));
	assert.ok(payload.iceServers[0].urls.length >= 4);
});

test("chat message is sanitized, broadcast, and replayed in history", async (t) => {
	const alice = await connectClient();
	const bob = await connectClient();
	const charlie = await connectClient();

	t.after(async () => {
		await disconnectClient(alice);
		await disconnectClient(bob);
		await disconnectClient(charlie);
	});

	const roomId = `chat-${Date.now()}`;

	await joinRoom(alice, roomId, "Alice");
	const alicePeerJoined = onceEvent(alice, "peer-joined");
	await joinRoom(bob, roomId, "Bob");

	const joinedPayload = await alicePeerJoined;
	assert.equal(joinedPayload.userName, "Bob");

	const bobChatPromise = onceEvent(bob, "chat-message");
	alice.emit("chat-message", { message: "   hello     team   " });

	const chatPayload = await bobChatPromise;
	assert.equal(chatPayload.fromName, "Alice");
	assert.equal(chatPayload.message, "hello team");

	const charlieHistoryPromise = onceEvent(charlie, "chat-history");
	await joinRoom(charlie, roomId, "Charlie");

	const historyPayload = await charlieHistoryPromise;
	assert.ok(Array.isArray(historyPayload.messages));
	assert.ok(
		historyPayload.messages.some((entry) => entry.message === "hello team"),
	);
});

test("switching rooms notifies old room with peer-left", async (t) => {
	const alice = await connectClient();
	const bob = await connectClient();

	t.after(async () => {
		await disconnectClient(alice);
		await disconnectClient(bob);
	});

	const oldRoomId = `old-${Date.now()}`;
	const newRoomId = `new-${Date.now()}`;

	await joinRoom(alice, oldRoomId, "Alice");
	await joinRoom(bob, oldRoomId, "Bob");

	const peerLeftPromise = onceEvent(bob, "peer-left");
	await joinRoom(alice, newRoomId, "Alice");

	const peerLeftPayload = await peerLeftPromise;
	assert.equal(peerLeftPayload.id, alice.id);
});
