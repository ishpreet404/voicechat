const joinPanel = document.getElementById("joinPanel");
const roomPanel = document.getElementById("roomPanel");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const serverUrlInput = document.getElementById("serverUrlInput");
const randomRoomBtn = document.getElementById("randomRoomBtn");
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

let socket;
let localStream;
let localScreenStream;
let localMuted = false;
let localDeafened = false;
let mutedBeforeDeafen = false;
let currentRoomId = "";

const peerConnections = new Map();
const screenSenders = new Map();
const remoteAudioElements = new Map();
const remoteScreenCards = new Map();
const participantState = new Map();

const rtcConfig = {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function randomRoom() {
	return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeName(value) {
	return value.trim().slice(0, 32);
}

function sanitizeRoom(value) {
	return value.trim().slice(0, 40);
}

function normalizeServerUrl(value) {
	const raw = String(value || "").trim();
	if (!raw) {
		return "";
	}

	let withProtocol = raw;
	if (!/^https?:\/\//i.test(withProtocol)) {
		if (
			withProtocol.startsWith("localhost") ||
			withProtocol.startsWith("127.0.0.1")
		) {
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
}

function setStatus(message) {
	statusText.textContent = message;
}

function updateScreensEmptyState() {
	screensEmpty.style.display = remoteScreenCards.size === 0 ? "block" : "none";
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

	const caption = document.createElement("figcaption");
	caption.textContent = `${peerName || "Guest"} - Screen`;

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
	updateParticipantList();

	if (socket && shouldEmit) {
		socket.emit("mute-state-changed", { muted: localMuted });
	}
}

function resetConnectionState() {
	for (const [, pc] of peerConnections) {
		pc.onicecandidate = null;
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
	for (const [, card] of remoteScreenCards) {
		card.remove();
	}
	remoteScreenCards.clear();
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
	deafenBtn.textContent = "Deafen";
	shareBtn.textContent = "Share Screen";
	currentRoomId = "";
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
		if (event.track.kind === "audio") {
			const audio = ensureAudioElement(peerId);
			audio.srcObject = event.streams[0];
			return;
		}

		if (event.track.kind === "video") {
			const card = ensureRemoteScreenCard(peerId, participantName);
			const video = card.querySelector("video");
			video.srcObject = event.streams[0];
			video.muted = localDeafened;
			event.track.onended = () => {
				removeRemoteScreen(peerId);
			};
		}
	};

	pc.onconnectionstatechange = () => {
		if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
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
}

async function joinRoom() {
	joinError.textContent = "";

	const userName = sanitizeName(nameInput.value) || "Guest";
	const roomId = sanitizeRoom(roomInput.value) || "lobby";
	const configuredServerUrl = normalizeServerUrl(serverUrlInput.value);

	if (serverUrlInput.value.trim() && !configuredServerUrl) {
		joinError.textContent = "Invalid signal server URL.";
		return;
	}

	try {
		setStatus("Starting microphone...");
		await startLocalAudio();

		if (configuredServerUrl) {
			localStorage.setItem("signalServerUrl", configuredServerUrl);
			socket = io(configuredServerUrl);
		} else {
			localStorage.removeItem("signalServerUrl");
			socket = io();
		}

		socket.on("connect", () => {
			currentRoomId = roomId;
			participantState.set(socket.id, {
				userName,
				muted: localMuted,
				sharing: Boolean(localScreenStream),
			});

			socket.emit("join-room", { roomId, userName });
			setStatus("Connected. Waiting for others...");
			updateParticipantList();
		});

		socket.on("room-participants", ({ roomId: joinedRoom, participants }) => {
			activeRoom.textContent = joinedRoom;
			setStatus(
				localDeafened
					? "Room connected. You are deafened."
					: "Room connected. Voice is live.",
			);

			for (const peer of participants) {
				participantState.set(peer.id, {
					userName: peer.userName,
					muted: peer.muted,
					sharing: Boolean(peer.sharing),
				});
			}

			updateParticipantList();
		});

		socket.on("peer-joined", async ({ id, userName: peerName, muted }) => {
			participantState.set(id, {
				userName: peerName,
				muted,
				sharing: false,
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
		});

		socket.on("signal-offer", async ({ from, fromName, offer }) => {
			const pc = createPeerConnection(from, fromName);
			await pc.setRemoteDescription(new RTCSessionDescription(offer));
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
		});

		socket.on("signal-ice-candidate", async ({ from, candidate }) => {
			const pc = peerConnections.get(from);
			if (!pc) {
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
			}
		});

		joinPanel.classList.add("hidden");
		roomPanel.classList.remove("hidden");
		activeRoom.textContent = roomId;
	} catch (error) {
		joinError.textContent = `Unable to join: ${error.message}`;
		setStatus("Microphone access is required.");
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
	shareBtn.textContent = "Share Screen";

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
				frameRate: 20,
			},
			audio: false,
		});

		const [videoTrack] = localScreenStream.getVideoTracks();
		if (!videoTrack) {
			throw new Error("No display track received.");
		}

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

function leaveRoom() {
	resetConnectionState();
	joinPanel.classList.remove("hidden");
	roomPanel.classList.add("hidden");
	setStatus("Disconnected.");
}

randomRoomBtn.addEventListener("click", () => {
	roomInput.value = randomRoom();
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

leaveBtn.addEventListener("click", () => {
	leaveRoom();
});

roomInput.value = randomRoom();
nameInput.value = `Guest-${Math.random().toString(36).slice(2, 5)}`;
serverUrlInput.value = localStorage.getItem("signalServerUrl") || "";
updateScreensEmptyState();
updateParticipantList();
