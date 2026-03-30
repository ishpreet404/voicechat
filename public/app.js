const joinPanel = document.getElementById("joinPanel");
const roomPanel = document.getElementById("roomPanel");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const serverUrlInput = document.getElementById("serverUrlInput");
const backendHint = document.getElementById("backendHint");
const backendStatus = document.getElementById("backendStatus");
const randomRoomBtn = document.getElementById("randomRoomBtn");
const permanentRoomBtn = document.getElementById("permanentRoomBtn");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");
const activeRoom = document.getElementById("activeRoom");
const muteBtn = document.getElementById("muteBtn");
const deafenBtn = document.getElementById("deafenBtn");
const shareBtn = document.getElementById("shareBtn");
const leaveBtn = document.getElementById("leaveBtn");
const statusText = document.getElementById("statusText");
const participantsList = document.getElementById("participants");
const screensGrid = document.getElementById("screensGrid");
const screensEmpty = document.getElementById("screensEmpty");
const participantCount = document.getElementById("participantCount");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

let socket;
let localStream;
let localScreenStream;
let localMuted = false;
let localDeafened = false;
let mutedBeforeDeafen = false;
let currentRoomId = "";
let joinInProgress = false;
let discoveredServerUrl = "";
let backendHealthDebounceTimer;
let backendHealthInterval;
let backendHealthRequestId = 0;

const peerConnections = new Map();
const screenSenders = new Map();
const remoteAudioElements = new Map();
const remoteScreenCards = new Map();
const participantState = new Map();
const peerDisconnectTimers = new Map();
const peerIceRecoveryTimers = new Map();
const pendingIceCandidates = new Map();
const blockedAudioPeers = new Set();
const peerIceRestartAttempts = new Map();
let audioUnlockHandlersBound = false;
let localScreenCard;

let rtcConfig = {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	iceCandidatePoolSize: 8,
};

let hasRelayIceServer = false;

const PERMANENT_ROOM_KEY = "permanentRoomId";
const BACKEND_HEALTH_CHECK_INTERVAL_MS = 30_000;
const BACKEND_HEALTH_CHECK_TIMEOUT_MS = 4_500;
const SCREEN_SHARE_MAX_BITRATE = 8_000_000;
const MAX_ICE_RESTART_ATTEMPTS = 2;
const ICE_RECOVERY_RETRY_DELAY_MS = 1200;

function setBackendStatus(state = "checking") {
	const safeState = ["connected", "disconnected", "checking"].includes(state)
		? state
		: "checking";
	const labelByState = {
		connected: "Connected",
		disconnected: "Disconnected",
		checking: "Checking",
	};

	backendStatus.textContent = `Backend: ${labelByState[safeState]}`;
	backendStatus.classList.remove("connected", "disconnected", "checking");
	backendStatus.classList.add(safeState);
	backendStatus.title = "Click to recheck backend status.";
	backendStatus.setAttribute(
		"aria-label",
		`Backend status ${labelByState[safeState]}`,
	);
	backendStatus.setAttribute(
		"aria-busy",
		safeState === "checking" ? "true" : "false",
	);
}

function setJoinInProgress(active) {
	joinInProgress = active;
	joinBtn.disabled = active;
	joinBtn.textContent = active ? "Connecting..." : "Enter Voice Room";
}

function randomRoom() {
	return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreatePermanentRoomId() {
	const stored = sanitizeRoom(localStorage.getItem(PERMANENT_ROOM_KEY) || "");
	if (stored) {
		return stored;
	}

	const created = `home-${Math.random().toString(36).slice(2, 10)}`;
	localStorage.setItem(PERMANENT_ROOM_KEY, created);
	return created;
}

function updateRoomUrl(roomId) {
	const cleanRoomId = sanitizeRoom(roomId);
	if (!cleanRoomId) {
		return;
	}

	const url = new URL(window.location.href);
	url.searchParams.set("room", cleanRoomId);
	history.replaceState({}, "", url.toString());
}

function readRoomIdFromUrl() {
	const url = new URL(window.location.href);
	return sanitizeRoom(url.searchParams.get("room") || "");
}

async function copyInviteLink() {
	const roomId = sanitizeRoom(roomInput.value) || getOrCreatePermanentRoomId();
	roomInput.value = roomId;
	updateRoomUrl(roomId);

	const inviteUrl = new URL(window.location.href);
	inviteUrl.searchParams.set("room", roomId);

	try {
		await navigator.clipboard.writeText(inviteUrl.toString());
		setStatus(`Invite link copied for room ${roomId}.`);
	} catch {
		setStatus(
			"Could not copy link automatically. Copy it from your browser address bar.",
		);
	}
}

function sanitizeName(value) {
	return value.trim().slice(0, 32);
}

function sanitizeRoom(value) {
	return value.trim().slice(0, 40);
}

function sanitizeChatMessage(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

function getIceServerUrls(iceServers) {
	const urls = [];

	for (const server of iceServers || []) {
		if (!server?.urls) {
			continue;
		}

		if (Array.isArray(server.urls)) {
			urls.push(...server.urls);
		} else {
			urls.push(server.urls);
		}
	}

	return urls.map((url) => String(url || "").trim().toLowerCase());
}

function detectRelayIceServer(iceServers) {
	return getIceServerUrls(iceServers).some(
		(url) => url.startsWith("turn:") || url.startsWith("turns:"),
	);
}

function clearPeerIceRecoveryTimer(peerId) {
	if (!peerIceRecoveryTimers.has(peerId)) {
		return;
	}

	clearTimeout(peerIceRecoveryTimers.get(peerId));
	peerIceRecoveryTimers.delete(peerId);
}

function formatChatTime(timestamp) {
	const date = new Date(timestamp || Date.now());
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function updateParticipantCount(value = participantState.size) {
	if (!participantCount) {
		return;
	}

	const normalized = Math.max(0, Number(value) || 0);
	participantCount.textContent = `${normalized} participant${normalized === 1 ? "" : "s"} in room`;
}

function renderChatEmptyState() {
	if (!chatMessages) {
		return;
	}

	if (chatMessages.children.length > 0) {
		return;
	}

	const li = document.createElement("li");
	li.className = "chat-empty";
	li.textContent = "No messages yet.";
	chatMessages.appendChild(li);
}

function clearChatMessages() {
	if (!chatMessages) {
		return;
	}

	chatMessages.innerHTML = "";
	renderChatEmptyState();
}

function appendChatMessage(payload) {
	if (!chatMessages) {
		return;
	}

	const safeMessage = sanitizeChatMessage(payload?.message);
	if (!safeMessage) {
		return;
	}

	const placeholder = chatMessages.querySelector(".chat-empty");
	if (placeholder) {
		placeholder.remove();
	}

	const li = document.createElement("li");
	li.className = "chat-message";

	if (payload?.fromId && payload.fromId === socket?.id) {
		li.classList.add("self");
	}

	const author = document.createElement("strong");
	author.textContent = payload?.fromName || "Guest";

	const message = document.createElement("p");
	message.textContent = safeMessage;

	const time = document.createElement("time");
	time.className = "chat-time";
	time.textContent = formatChatTime(payload?.at);

	li.appendChild(author);
	li.appendChild(message);
	li.appendChild(time);
	chatMessages.appendChild(li);
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHistory(messages) {
	if (!chatMessages) {
		return;
	}

	chatMessages.innerHTML = "";
	for (const item of messages || []) {
		appendChatMessage(item);
	}
	renderChatEmptyState();
}

function hostLooksLikeIpv4Address(host) {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function shouldDefaultToHttp(rawHostValue) {
	const hostValue = String(rawHostValue || "")
		.trim()
		.toLowerCase();
	const host = hostValue.split("/")[0].split(":")[0];

	if (!host) {
		return false;
	}

	if (["localhost", "127.0.0.1", "0.0.0.0"].includes(host)) {
		return true;
	}

	if (hostLooksLikeIpv4Address(host) || host.endsWith(".local")) {
		return true;
	}

	return false;
}

function normalizeServerUrl(value) {
	const raw = String(value || "").trim();
	if (!raw) {
		return "";
	}

	let withProtocol = raw;
	if (!/^https?:\/\//i.test(withProtocol)) {
		if (shouldDefaultToHttp(withProtocol)) {
			withProtocol = `http://${withProtocol}`;
		} else {
			withProtocol = `https://${withProtocol}`;
		}
	}

	try {
		const url = new URL(withProtocol);
		return url.origin;
	} catch {
		return "";
	}
}

async function discoverBackendUrl() {
	try {
		const response = await fetch("/api/socket-url", { cache: "no-store" });
		if (!response.ok) {
			return "";
		}

		const payload = await response.json();
		return normalizeServerUrl(payload.socketServerUrl || "");
	} catch {
		return "";
	}
}

async function loadRtcConfig(socketServerUrl) {
	const baseUrl = socketServerUrl || window.location.origin;
	try {
		const response = await fetch(`${baseUrl}/rtc-config`, {
			cache: "no-store",
		});
		if (!response.ok) {
			return;
		}

		const payload = await response.json();
		if (payload?.iceServers?.length) {
			rtcConfig = {
				...rtcConfig,
				iceServers: payload.iceServers,
			};
		}
	} catch {
		setStatus(
			"Using fallback ICE config. If voice fails, verify CORS_ORIGIN and TURN settings.",
		);
	} finally {
		hasRelayIceServer = detectRelayIceServer(rtcConfig.iceServers);
	}
}

function resolveSocketServerUrl() {
	const manual = normalizeServerUrl(serverUrlInput.value);
	if (manual) {
		return manual;
	}

	if (discoveredServerUrl) {
		return discoveredServerUrl;
	}

	return window.location.origin;
}

async function checkBackendHealth({ showChecking = false } = {}) {
	const requestId = ++backendHealthRequestId;
	const serverUrl = resolveSocketServerUrl();
	const manualInput = String(serverUrlInput.value || "").trim();
	if (manualInput && !normalizeServerUrl(manualInput)) {
		setBackendStatus("disconnected");
		return false;
	}

	const isSameOriginBackend = serverUrl === window.location.origin;
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, BACKEND_HEALTH_CHECK_TIMEOUT_MS);

	if (showChecking) {
		setBackendStatus("checking");
	}

	try {
		const response = await fetch(`${serverUrl}/health`, {
			cache: "no-store",
			mode: isSameOriginBackend ? "same-origin" : "no-cors",
			signal: controller.signal,
		});
		const isHealthy = isSameOriginBackend ? response.ok : true;

		if (requestId === backendHealthRequestId) {
			setBackendStatus(isHealthy ? "connected" : "disconnected");
		}

		return isHealthy;
	} catch {
		if (requestId === backendHealthRequestId) {
			setBackendStatus("disconnected");
		}

		return false;
	} finally {
		clearTimeout(timeout);
	}
}

function scheduleBackendHealthCheck(delayMs = 220) {
	if (backendHealthDebounceTimer) {
		clearTimeout(backendHealthDebounceTimer);
	}

	backendHealthDebounceTimer = setTimeout(() => {
		checkBackendHealth({ showChecking: true }).catch(() => {
			setBackendStatus("disconnected");
		});
	}, delayMs);
}

function startBackendHealthMonitor() {
	if (backendHealthInterval) {
		clearInterval(backendHealthInterval);
	}

	backendHealthInterval = setInterval(() => {
		checkBackendHealth().catch(() => {
			setBackendStatus("disconnected");
		});
	}, BACKEND_HEALTH_CHECK_INTERVAL_MS);
}

async function attemptIceRestart(peerId, pc, reason) {
	if (!socket || !pc || pc.signalingState === "closed") {
		return;
	}

	const attempts = peerIceRestartAttempts.get(peerId) || 0;
	if (attempts >= MAX_ICE_RESTART_ATTEMPTS) {
		if (!hasRelayIceServer) {
			setStatus(
				"P2P media connection failed. Configure TURN relay (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL).",
			);
		} else {
			setStatus(
				"P2P media connection failed after retries. Ask the peer to reconnect.",
			);
		}
		return;
	}

	peerIceRestartAttempts.set(peerId, attempts + 1);
	setStatus(
		`Network recovery in progress (${attempts + 1}/${MAX_ICE_RESTART_ATTEMPTS})...`,
	);

	try {
		const offer = await pc.createOffer({ iceRestart: true });
		await pc.setLocalDescription(offer);
		socket.emit("signal-offer", {
			to: peerId,
			offer,
		});
	} catch (error) {
		console.warn(`ICE restart failed (${reason}) for peer ${peerId}:`, error);
	}
}

function queuePendingIceCandidate(peerId, candidate) {
	if (!pendingIceCandidates.has(peerId)) {
		pendingIceCandidates.set(peerId, []);
	}

	pendingIceCandidates.get(peerId).push(candidate);
}

async function flushPendingIceCandidates(peerId, pc) {
	if (!pc.remoteDescription?.type) {
		return;
	}

	const queued = pendingIceCandidates.get(peerId);
	if (!queued?.length) {
		return;
	}

	pendingIceCandidates.delete(peerId);

	for (const candidate of queued) {
		try {
			await pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			console.warn("Queued ICE candidate error:", error);
		}
	}
}

function detachAudioUnlockHandlers() {
	if (!audioUnlockHandlersBound) {
		return;
	}

	window.removeEventListener("click", retryBlockedRemoteAudioPlayback);
	window.removeEventListener("touchstart", retryBlockedRemoteAudioPlayback);
	window.removeEventListener("keydown", retryBlockedRemoteAudioPlayback);
	audioUnlockHandlersBound = false;
}

async function retryBlockedRemoteAudioPlayback() {
	const pending = [...blockedAudioPeers];

	for (const peerId of pending) {
		const audio = remoteAudioElements.get(peerId);
		if (!audio) {
			blockedAudioPeers.delete(peerId);
			continue;
		}

		try {
			await audio.play();
			blockedAudioPeers.delete(peerId);
		} catch {
			// Keep waiting for the next explicit user interaction.
		}
	}

	if (blockedAudioPeers.size === 0) {
		detachAudioUnlockHandlers();
	}
}

function ensureAudioUnlockHandlers() {
	if (audioUnlockHandlersBound) {
		return;
	}

	window.addEventListener("click", retryBlockedRemoteAudioPlayback);
	window.addEventListener("touchstart", retryBlockedRemoteAudioPlayback);
	window.addEventListener("keydown", retryBlockedRemoteAudioPlayback);
	audioUnlockHandlersBound = true;
}

async function playRemoteAudio(peerId, audio) {
	const wasBlocked = blockedAudioPeers.has(peerId);

	try {
		await audio.play();
		blockedAudioPeers.delete(peerId);

		if (blockedAudioPeers.size === 0) {
			detachAudioUnlockHandlers();
		}
	} catch {
		blockedAudioPeers.add(peerId);
		ensureAudioUnlockHandlers();

		if (!wasBlocked) {
			setStatus("Tap once to enable incoming audio.");
		}
	}
}

function updateParticipantList() {
	const entries = [...participantState.entries()];

	participantsList.innerHTML = "";

	for (const [id, participant] of entries) {
		const li = document.createElement("li");
		li.className = "participant";

		const name = document.createElement("strong");
		name.textContent = participant.userName;

		const meta = document.createElement("div");
		meta.className = "participant-meta";

		const badge = document.createElement("span");
		badge.className = `badge ${participant.muted ? "muted" : "live"}`;
		badge.textContent = participant.muted ? "Muted" : "Live";
		meta.appendChild(badge);

		if (participant.sharing) {
			const sharingBadge = document.createElement("span");
			sharingBadge.className = "badge sharing";
			sharingBadge.textContent = "Sharing";
			meta.appendChild(sharingBadge);
		}

		li.appendChild(name);
		li.appendChild(meta);

		participantsList.appendChild(li);
	}

	if (entries.length === 0) {
		const li = document.createElement("li");
		li.className = "participant";
		li.textContent = "No one is here yet.";
		participantsList.appendChild(li);
	}

	updateParticipantCount(entries.length);
}

function setStatus(message) {
	statusText.textContent = message;
}

function toggleFullscreenForElement(element) {
	if (!element?.requestFullscreen) {
		return;
	}

	if (document.fullscreenElement === element) {
		if (document.exitFullscreen) {
			document.exitFullscreen().catch(() => {
				// Ignore user-triggered fullscreen exit errors.
			});
		}
		return;
	}

	element.requestFullscreen().catch(() => {
		setStatus("Fullscreen is blocked by browser policy.");
	});
}

function createScreenCaption(labelText, fullscreenTarget) {
	const caption = document.createElement("figcaption");
	const text = document.createElement("span");
	text.textContent = labelText;

	const fullscreenBtn = document.createElement("button");
	fullscreenBtn.type = "button";
	fullscreenBtn.className = "screen-fullscreen-btn";
	fullscreenBtn.textContent = "Full Screen";
	fullscreenBtn.setAttribute("aria-label", `Open full screen for ${labelText}`);
	fullscreenBtn.addEventListener("click", () => {
		toggleFullscreenForElement(fullscreenTarget);
	});

	caption.appendChild(text);
	caption.appendChild(fullscreenBtn);
	return caption;
}

function updateScreensEmptyState() {
	const hasAnyScreen = remoteScreenCards.size > 0 || Boolean(localScreenCard);
	screensEmpty.style.display = hasAnyScreen ? "none" : "block";
}

function removeLocalScreenPreview() {
	if (!localScreenCard) {
		return;
	}

	localScreenCard.remove();
	localScreenCard = undefined;
	updateScreensEmptyState();
}

function ensureLocalScreenPreview(displayName) {
	if (localScreenCard) {
		return localScreenCard;
	}

	const figure = document.createElement("figure");
	figure.className = "screen-card self-share";

	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	video.muted = true;

	const caption = createScreenCaption(
		`${displayName || "You"} - Your Screen`,
		video,
	);

	figure.appendChild(video);
	figure.appendChild(caption);
	screensGrid.appendChild(figure);
	localScreenCard = figure;
	updateScreensEmptyState();
	return figure;
}

function removeRemoteScreen(peerId) {
	const card = remoteScreenCards.get(peerId);
	if (!card) {
		return;
	}
	card.remove();
	remoteScreenCards.delete(peerId);
	updateScreensEmptyState();
}

function ensureRemoteScreenCard(peerId, peerName) {
	if (remoteScreenCards.has(peerId)) {
		return remoteScreenCards.get(peerId);
	}

	const figure = document.createElement("figure");
	figure.className = "screen-card";

	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	video.muted = localDeafened;

	const caption = createScreenCaption(`${peerName || "Guest"} - Screen`, video);

	figure.appendChild(video);
	figure.appendChild(caption);
	screensGrid.appendChild(figure);
	remoteScreenCards.set(peerId, figure);
	updateScreensEmptyState();
	return figure;
}

async function renegotiatePeer(peerId, pc) {
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	socket.emit("signal-offer", {
		to: peerId,
		offer,
	});
}

function applyRemoteAudioState() {
	for (const [, audio] of remoteAudioElements) {
		audio.muted = localDeafened;
		audio.volume = localDeafened ? 0 : 1;
	}

	for (const [, card] of remoteScreenCards) {
		const video = card.querySelector("video");
		if (video) {
			video.muted = localDeafened;
			video.volume = localDeafened ? 0 : 1;
		}
	}
}

function setLocalMuteState(nextMuted, shouldEmit = true) {
	localMuted = Boolean(nextMuted);

	if (localStream) {
		localStream.getAudioTracks().forEach((track) => {
			track.enabled = !localMuted;
		});
	}

	if (socket?.id) {
		const self = participantState.get(socket.id);
		if (self) {
			self.muted = localMuted;
		}
	}

	muteBtn.textContent = localMuted ? "Unmute" : "Mute";
	muteBtn.setAttribute("aria-pressed", localMuted ? "true" : "false");
	updateParticipantList();

	if (socket && shouldEmit) {
		socket.emit("mute-state-changed", { muted: localMuted });
	}
}

function refreshBackendStatus() {
	scheduleBackendHealthCheck();
}

async function initializeBackendConfig() {
	const savedServerUrl = normalizeServerUrl(
		localStorage.getItem("signalServerUrl") || "",
	);
	if (savedServerUrl) {
		serverUrlInput.value = savedServerUrl;
	}

	if (!savedServerUrl) {
		discoveredServerUrl = await discoverBackendUrl();
		if (discoveredServerUrl) {
			backendHint.textContent =
				"Auto-loaded from Vercel env SIGNAL_SERVER_URL.";
		}
	}

	startBackendHealthMonitor();
	refreshBackendStatus();
}

function resetConnectionState() {
	for (const [, timer] of peerDisconnectTimers) {
		clearTimeout(timer);
	}

	for (const [, timer] of peerIceRecoveryTimers) {
		clearTimeout(timer);
	}

	for (const [, pc] of peerConnections) {
		pc.onicecandidate = null;
		pc.onicecandidateerror = null;
		pc.oniceconnectionstatechange = null;
		pc.ontrack = null;
		pc.onconnectionstatechange = null;
		pc.close();
	}

	for (const [, audio] of remoteAudioElements) {
		audio.srcObject = null;
		audio.remove();
	}

	peerConnections.clear();
	screenSenders.clear();
	remoteAudioElements.clear();
	peerDisconnectTimers.clear();
	peerIceRecoveryTimers.clear();
	pendingIceCandidates.clear();
	blockedAudioPeers.clear();
	peerIceRestartAttempts.clear();
	detachAudioUnlockHandlers();
	for (const [, card] of remoteScreenCards) {
		card.remove();
	}
	remoteScreenCards.clear();
	removeLocalScreenPreview();
	participantState.clear();
	localMuted = false;
	localDeafened = false;
	mutedBeforeDeafen = false;

	if (localScreenStream) {
		localScreenStream.getTracks().forEach((track) => track.stop());
		localScreenStream = undefined;
	}

	if (localStream) {
		localStream.getTracks().forEach((track) => track.stop());
		localStream = undefined;
	}

	if (socket) {
		socket.disconnect();
		socket = undefined;
	}

	muteBtn.textContent = "Mute";
	muteBtn.setAttribute("aria-pressed", "false");
	deafenBtn.textContent = "Deafen";
	deafenBtn.setAttribute("aria-pressed", "false");
	shareBtn.textContent = "Share Screen";
	shareBtn.setAttribute("aria-pressed", "false");
	currentRoomId = "";
	if (chatInput) {
		chatInput.value = "";
	}
	clearChatMessages();
	setJoinInProgress(false);
	updateScreensEmptyState();
	updateParticipantList();
}

function ensureAudioElement(peerId) {
	if (remoteAudioElements.has(peerId)) {
		return remoteAudioElements.get(peerId);
	}

	const audio = document.createElement("audio");
	audio.autoplay = true;
	audio.playsInline = true;
	audio.muted = localDeafened;
	remoteAudioElements.set(peerId, audio);
	document.body.appendChild(audio);
	return audio;
}

function removePeer(peerId) {
	if (peerDisconnectTimers.has(peerId)) {
		clearTimeout(peerDisconnectTimers.get(peerId));
		peerDisconnectTimers.delete(peerId);
	}

	clearPeerIceRecoveryTimer(peerId);

	if (peerConnections.has(peerId)) {
		const pc = peerConnections.get(peerId);
		pc.close();
		peerConnections.delete(peerId);
	}

	if (remoteAudioElements.has(peerId)) {
		const audio = remoteAudioElements.get(peerId);
		audio.srcObject = null;
		audio.remove();
		remoteAudioElements.delete(peerId);
	}

	pendingIceCandidates.delete(peerId);
	blockedAudioPeers.delete(peerId);
	peerIceRestartAttempts.delete(peerId);
	if (blockedAudioPeers.size === 0) {
		detachAudioUnlockHandlers();
	}

	participantState.delete(peerId);
	removeRemoteScreen(peerId);
	updateParticipantList();
}

function attachScreenTrackToPeer(peerId, pc) {
	if (!localScreenStream) {
		return;
	}

	const [videoTrack] = localScreenStream.getVideoTracks();
	if (!videoTrack) {
		return;
	}

	const sender = pc.addTrack(videoTrack, localScreenStream);
	screenSenders.set(peerId, sender);

	const params = sender.getParameters();
	if (!params.encodings || !params.encodings.length) {
		params.encodings = [{}];
	}
	params.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE;
	params.encodings[0].maxFramerate = 60;

	sender.setParameters(params).catch(() => {
		// Some browsers reject custom sender parameters; keep defaults.
	});
}

function createPeerConnection(peerId, peerName) {
	if (peerConnections.has(peerId)) {
		return peerConnections.get(peerId);
	}

	const pc = new RTCPeerConnection(rtcConfig);

	localStream.getAudioTracks().forEach((track) => {
		pc.addTrack(track, localStream);
	});

	attachScreenTrackToPeer(peerId, pc);

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit("signal-ice-candidate", {
				to: peerId,
				candidate: event.candidate,
			});
		}
	};

	pc.ontrack = (event) => {
		const participantName =
			participantState.get(peerId)?.userName || peerName || "Guest";
		const stream =
			event.streams && event.streams[0]
				? event.streams[0]
				: new MediaStream([event.track]);
		if (event.track.kind === "audio") {
			const audio = ensureAudioElement(peerId);
			audio.srcObject = new MediaStream([event.track]);
			event.track.onunmute = () => {
				playRemoteAudio(peerId, audio).catch(() => {
					// Playback retry is handled by user interaction hooks.
				});
			};
			playRemoteAudio(peerId, audio).catch(() => {
				// Playback retry is handled by user interaction hooks.
			});
			return;
		}

		if (event.track.kind === "video") {
			const card = ensureRemoteScreenCard(peerId, participantName);
			const video = card.querySelector("video");
			video.srcObject = stream;
			video.muted = localDeafened;
			event.track.onended = () => {
				removeRemoteScreen(peerId);
			};
		}
	};

	pc.onicecandidateerror = (event) => {
		console.warn("ICE candidate gathering error:", {
			peerId,
			errorCode: event?.errorCode,
			errorText: event?.errorText,
			url: event?.url,
		});
	};

	pc.oniceconnectionstatechange = () => {
		const iceState = pc.iceConnectionState;

		if (["connected", "completed"].includes(iceState)) {
			clearPeerIceRecoveryTimer(peerId);
			peerIceRestartAttempts.delete(peerId);
			return;
		}

		if (iceState === "failed") {
			clearPeerIceRecoveryTimer(peerId);
			attemptIceRestart(peerId, pc, "failed").catch(() => {
				// Recovery errors are handled in attemptIceRestart.
			});
			return;
		}

		if (iceState === "disconnected") {
			if (peerIceRecoveryTimers.has(peerId)) {
				return;
			}

			const timer = setTimeout(() => {
				peerIceRecoveryTimers.delete(peerId);
				const currentPc = peerConnections.get(peerId);
				if (!currentPc || currentPc.signalingState === "closed") {
					return;
				}

				if (
					["disconnected", "failed"].includes(currentPc.iceConnectionState)
				) {
					attemptIceRestart(peerId, currentPc, "disconnected").catch(() => {
						// Recovery errors are handled in attemptIceRestart.
					});
				}
			}, ICE_RECOVERY_RETRY_DELAY_MS);

			peerIceRecoveryTimers.set(peerId, timer);
		}
	};

	pc.onconnectionstatechange = () => {
		if (pc.connectionState === "disconnected") {
			if (!peerDisconnectTimers.has(peerId)) {
				const timer = setTimeout(() => {
					const currentPc = peerConnections.get(peerId);
					if (!currentPc) {
						return;
					}

					if (
						currentPc.connectionState === "disconnected" ||
						currentPc.connectionState === "failed" ||
						currentPc.connectionState === "closed"
					) {
						removePeer(peerId);
					}
				}, 12000);

				peerDisconnectTimers.set(peerId, timer);
			}
			return;
		}

		if (pc.connectionState === "failed") {
			attemptIceRestart(peerId, pc, "connection-failed").catch(() => {
				// Recovery errors are handled in attemptIceRestart.
			});

			if (!peerDisconnectTimers.has(peerId)) {
				const timer = setTimeout(() => {
					const currentPc = peerConnections.get(peerId);
					if (!currentPc) {
						return;
					}

					if (currentPc.connectionState === "failed") {
						removePeer(peerId);
					}
				}, 15000);

				peerDisconnectTimers.set(peerId, timer);
			}
			return;
		}

		if (peerDisconnectTimers.has(peerId)) {
			clearTimeout(peerDisconnectTimers.get(peerId));
			peerDisconnectTimers.delete(peerId);
		}

		clearPeerIceRecoveryTimer(peerId);
		peerIceRestartAttempts.delete(peerId);

		if (pc.connectionState === "closed") {
			removePeer(peerId);
		}
	};

	peerConnections.set(peerId, pc);

	if (!participantState.has(peerId)) {
		participantState.set(peerId, {
			userName: peerName || "Guest",
			muted: false,
			sharing: false,
		});
		updateParticipantList();
	}

	return pc;
}

async function startLocalAudio() {
	localStream = await navigator.mediaDevices.getUserMedia({
		audio: {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		video: false,
	});

	if (!localStream.getAudioTracks().length) {
		throw new Error("Microphone track not available.");
	}
}

async function joinRoom() {
	if (joinInProgress) {
		return;
	}

	joinError.textContent = "";

	const userName = sanitizeName(nameInput.value) || "Guest";
	const roomId = sanitizeRoom(roomInput.value) || "lobby";
	const manualServerUrl = normalizeServerUrl(serverUrlInput.value);
	const hasManualServerUrl = Boolean(serverUrlInput.value.trim());
	const configuredServerUrl = resolveSocketServerUrl();
	const hasExplicitServerUrl = Boolean(manualServerUrl || discoveredServerUrl);

	if (hasManualServerUrl && !manualServerUrl) {
		joinError.textContent = "Invalid signal server URL.";
		return;
	}

	setJoinInProgress(true);

	try {
		setStatus("Starting microphone...");
		await startLocalAudio();
		await loadRtcConfig(configuredServerUrl);

		if (hasExplicitServerUrl) {
			localStorage.setItem("signalServerUrl", configuredServerUrl);
		} else {
			localStorage.removeItem("signalServerUrl");
		}

		socket = io(configuredServerUrl, {
			transports: ["websocket", "polling"],
			timeout: 20000,
			reconnection: true,
			reconnectionAttempts: 25,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
		});

		let initialConnectDone = false;

		socket.on("connect", () => {
			initialConnectDone = true;
			currentRoomId = roomId;
			participantState.clear();
			clearChatMessages();
			participantState.set(socket.id, {
				userName,
				muted: localMuted,
				sharing: Boolean(localScreenStream),
			});

			socket.emit("join-room", { roomId, userName });
			setStatus("Connected. Waiting for others...");
			setBackendStatus("connected");
			updateParticipantList();

			joinPanel.classList.add("hidden");
			roomPanel.classList.remove("hidden");
			activeRoom.textContent = roomId;
			setJoinInProgress(false);
		});

		socket.on("connect_error", (error) => {
			if (initialConnectDone) {
				setStatus("Connection lost. Trying to reconnect...");
				setBackendStatus("checking");
				return;
			}

			joinError.textContent = `Unable to connect backend: ${error.message}`;
			setStatus("Cannot reach backend server.");
			setBackendStatus("disconnected");
			setJoinInProgress(false);
			resetConnectionState();
			joinPanel.classList.remove("hidden");
			roomPanel.classList.add("hidden");
		});

		socket.on("room-participants", ({ roomId: joinedRoom, participants }) => {
			activeRoom.textContent = joinedRoom;
			updateRoomUrl(joinedRoom);

			const selfParticipant = participantState.get(socket.id) || {
				userName,
				muted: localMuted,
				sharing: Boolean(localScreenStream),
			};
			participantState.clear();
			participantState.set(socket.id, selfParticipant);

			setStatus(
				localDeafened
					? "Room connected. You are deafened."
					: "Room connected. Voice is live.",
			);

			for (const peer of participants) {
				if (peer.id === socket.id) {
					continue;
				}

				participantState.set(peer.id, {
					userName: peer.userName,
					muted: peer.muted,
					sharing: Boolean(peer.sharing),
				});
			}

			updateParticipantList();
		});

		socket.on("room-meta", ({ participantCount: count }) => {
			updateParticipantCount(count);
		});

		socket.on("chat-history", ({ messages }) => {
			renderChatHistory(messages);
		});

		socket.on("chat-message", (payload) => {
			appendChatMessage(payload);
		});

		socket.on(
			"peer-joined",
			async ({ id, userName: peerName, muted, sharing }) => {
				if (id === socket.id) {
					return;
				}

				participantState.set(id, {
					userName: peerName,
					muted,
					sharing: Boolean(sharing),
				});
				updateParticipantList();

				const pc = createPeerConnection(id, peerName);
				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);

				socket.emit("signal-offer", {
					to: id,
					offer,
				});

				setStatus(`${peerName} joined the room.`);
			},
		);

		socket.on("signal-offer", async ({ from, fromName, offer }) => {
			const pc = createPeerConnection(from, fromName);
			await pc.setRemoteDescription(new RTCSessionDescription(offer));
			await flushPendingIceCandidates(from, pc);
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);

			socket.emit("signal-answer", {
				to: from,
				answer,
			});
		});

		socket.on("signal-answer", async ({ from, answer }) => {
			const pc = peerConnections.get(from);
			if (!pc) {
				return;
			}

			await pc.setRemoteDescription(new RTCSessionDescription(answer));
			await flushPendingIceCandidates(from, pc);
		});

		socket.on("signal-ice-candidate", async ({ from, candidate }) => {
			const pc = peerConnections.get(from);
			if (!pc) {
				queuePendingIceCandidate(from, candidate);
				return;
			}

			if (!pc.remoteDescription?.type) {
				queuePendingIceCandidate(from, candidate);
				return;
			}

			try {
				await pc.addIceCandidate(new RTCIceCandidate(candidate));
			} catch (error) {
				console.error("ICE candidate error:", error);
			}
		});

		socket.on("peer-left", ({ id }) => {
			const leavingName = participantState.get(id)?.userName || "A user";
			removePeer(id);
			setStatus(`${leavingName} left the room.`);
		});

		socket.on("peer-mute-state", ({ id, muted }) => {
			const participant = participantState.get(id);
			if (!participant) {
				return;
			}
			participant.muted = muted;
			updateParticipantList();
		});

		socket.on("peer-screen-share-state", ({ id, sharing }) => {
			const participant = participantState.get(id);
			if (participant) {
				participant.sharing = Boolean(sharing);
			}

			if (!sharing) {
				removeRemoteScreen(id);
			}

			updateParticipantList();
		});

		socket.on("disconnect", () => {
			if (currentRoomId) {
				setStatus("Disconnected from room.");
				setBackendStatus("disconnected");
			}
		});
	} catch (error) {
		joinError.textContent = `Unable to join: ${error.message}`;
		if (!window.isSecureContext) {
			setStatus(
				"Microphone access is blocked on insecure pages. Use HTTPS (or localhost).",
			);
		} else {
			setStatus("Microphone access is required.");
		}
		setJoinInProgress(false);
		resetConnectionState();
		joinPanel.classList.remove("hidden");
		roomPanel.classList.add("hidden");
	}
}

function toggleMute() {
	if (!localStream || !socket) {
		return;
	}

	if (localDeafened && localMuted) {
		setStatus("Undeafen first to unmute your microphone.");
		return;
	}

	setLocalMuteState(!localMuted, true);
	setStatus(localMuted ? "Your mic is muted." : "Your mic is live.");
}

function toggleDeafen() {
	if (!localStream || !socket) {
		return;
	}

	localDeafened = !localDeafened;
	deafenBtn.textContent = localDeafened ? "Undeafen" : "Deafen";
	deafenBtn.setAttribute("aria-pressed", localDeafened ? "true" : "false");

	if (localDeafened) {
		mutedBeforeDeafen = localMuted;
		setLocalMuteState(true, true);
	} else {
		setLocalMuteState(mutedBeforeDeafen, true);
	}

	applyRemoteAudioState();
	setStatus(
		localDeafened
			? "You are deafened (incoming muted + mic muted)."
			: "Deafen disabled. Audio restored.",
	);
}

async function stopScreenShare(emitState = true) {
	if (!localScreenStream || !socket) {
		return;
	}

	const peers = [...peerConnections.entries()];
	for (const [peerId, pc] of peers) {
		const sender = screenSenders.get(peerId);
		if (sender) {
			pc.removeTrack(sender);
			screenSenders.delete(peerId);
			await renegotiatePeer(peerId, pc);
		}
	}

	localScreenStream.getTracks().forEach((track) => track.stop());
	localScreenStream = undefined;
	removeLocalScreenPreview();
	shareBtn.textContent = "Share Screen";
	shareBtn.setAttribute("aria-pressed", "false");

	const self = participantState.get(socket.id);
	if (self) {
		self.sharing = false;
	}
	updateParticipantList();

	if (emitState) {
		socket.emit("screen-share-state-changed", { sharing: false });
	}
}

async function startScreenShare() {
	if (!socket || !localStream) {
		return;
	}

	try {
		localScreenStream = await navigator.mediaDevices.getDisplayMedia({
			video: {
				width: { ideal: 1920, max: 3840 },
				height: { ideal: 1080, max: 2160 },
				frameRate: { ideal: 30, max: 60 },
			},
			audio: false,
		});

		const [videoTrack] = localScreenStream.getVideoTracks();
		if (!videoTrack) {
			throw new Error("No display track received.");
		}

		if ("contentHint" in videoTrack) {
			videoTrack.contentHint = "detail";
		}

		await videoTrack
			.applyConstraints({
				width: { ideal: 1920, max: 3840 },
				height: { ideal: 1080, max: 2160 },
				frameRate: { ideal: 30, max: 60 },
			})
			.catch(() => {
				// Some devices cannot satisfy strict display constraints.
			});

		const selfName =
			participantState.get(socket.id)?.userName ||
			sanitizeName(nameInput.value) ||
			"You";
		const localCard = ensureLocalScreenPreview(selfName);
		const localVideo = localCard.querySelector("video");
		localVideo.srcObject = localScreenStream;

		videoTrack.onended = () => {
			stopScreenShare(true).catch((error) => {
				console.error("Stop share error:", error);
			});
		};

		const peers = [...peerConnections.entries()];
		for (const [peerId, pc] of peers) {
			attachScreenTrackToPeer(peerId, pc);
			await renegotiatePeer(peerId, pc);
		}

		const self = participantState.get(socket.id);
		if (self) {
			self.sharing = true;
		}

		shareBtn.textContent = "Stop Share";
		shareBtn.setAttribute("aria-pressed", "true");
		updateParticipantList();
		socket.emit("screen-share-state-changed", { sharing: true });
		setStatus("You started sharing your screen.");
	} catch (error) {
		localScreenStream = undefined;
		setStatus(`Screen share failed: ${error.message}`);
	}
}

async function toggleScreenShare() {
	if (localScreenStream) {
		await stopScreenShare(true);
		setStatus("You stopped sharing your screen.");
		return;
	}

	await startScreenShare();
}

function sendChatMessage() {
	if (!chatInput) {
		return;
	}

	if (!socket || !currentRoomId) {
		setStatus("Join a room before sending chat messages.");
		return;
	}

	const message = sanitizeChatMessage(chatInput.value);
	if (!message) {
		return;
	}

	socket.emit("chat-message", { message });
	chatInput.value = "";
	chatInput.focus();
}

function leaveRoom() {
	resetConnectionState();
	joinPanel.classList.remove("hidden");
	roomPanel.classList.add("hidden");
	setStatus("Disconnected.");
}

randomRoomBtn.addEventListener("click", () => {
	roomInput.value = randomRoom();
});

serverUrlInput.addEventListener("input", () => {
	refreshBackendStatus();
});

backendStatus.addEventListener("click", () => {
	checkBackendHealth({ showChecking: true }).catch(() => {
		setBackendStatus("disconnected");
	});
});

permanentRoomBtn.addEventListener("click", () => {
	const roomId = getOrCreatePermanentRoomId();
	roomInput.value = roomId;
	updateRoomUrl(roomId);
	setStatus(`Using your constant room ID: ${roomId}`);
});

copyInviteBtn.addEventListener("click", () => {
	copyInviteLink().catch((error) => {
		setStatus(`Unable to copy invite: ${error.message}`);
	});
});

joinBtn.addEventListener("click", () => {
	joinRoom();
});

muteBtn.addEventListener("click", () => {
	toggleMute();
});

deafenBtn.addEventListener("click", () => {
	toggleDeafen();
});

shareBtn.addEventListener("click", () => {
	toggleScreenShare().catch((error) => {
		setStatus(`Screen share error: ${error.message}`);
	});
});

if (chatSendBtn) {
	chatSendBtn.addEventListener("click", () => {
		sendChatMessage();
	});
}

if (chatInput) {
	chatInput.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey) {
			return;
		}

		event.preventDefault();
		sendChatMessage();
	});
}

leaveBtn.addEventListener("click", () => {
	leaveRoom();
});

window.addEventListener("beforeunload", () => {
	if (backendHealthDebounceTimer) {
		clearTimeout(backendHealthDebounceTimer);
	}

	if (backendHealthInterval) {
		clearInterval(backendHealthInterval);
	}

	detachAudioUnlockHandlers();
});

roomInput.value = readRoomIdFromUrl() || getOrCreatePermanentRoomId();
nameInput.value = `Guest-${Math.random().toString(36).slice(2, 5)}`;
muteBtn.setAttribute("aria-pressed", "false");
deafenBtn.setAttribute("aria-pressed", "false");
shareBtn.setAttribute("aria-pressed", "false");
clearChatMessages();
updateScreensEmptyState();
updateParticipantList();
initializeBackendConfig().catch(() => {
	setBackendStatus("disconnected");
});
