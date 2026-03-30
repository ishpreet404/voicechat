const joinPanel = document.getElementById("joinPanel");
const roomPanel = document.getElementById("roomPanel");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const randomRoomBtn = document.getElementById("randomRoomBtn");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");
const activeRoom = document.getElementById("activeRoom");
const muteBtn = document.getElementById("muteBtn");
const leaveBtn = document.getElementById("leaveBtn");
const statusText = document.getElementById("statusText");
const participantsList = document.getElementById("participants");

let socket;
let localStream;
let localMuted = false;
let currentRoomId = "";

const peerConnections = new Map();
const remoteAudioElements = new Map();
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

function updateParticipantList() {
  const entries = [...participantState.entries()];

  participantsList.innerHTML = "";

  for (const [id, participant] of entries) {
    const li = document.createElement("li");
    li.className = "participant";

    const name = document.createElement("strong");
    name.textContent = participant.userName;

    const badge = document.createElement("span");
    badge.className = `badge ${participant.muted ? "muted" : "live"}`;
    badge.textContent = participant.muted ? "Muted" : "Live";

    li.appendChild(name);
    li.appendChild(badge);

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
  remoteAudioElements.clear();
  participantState.clear();
  localMuted = false;

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = undefined;
  }

  if (socket) {
    socket.disconnect();
    socket = undefined;
  }

  muteBtn.textContent = "Mute";
  currentRoomId = "";
  updateParticipantList();
}

function ensureAudioElement(peerId) {
  if (remoteAudioElements.has(peerId)) {
    return remoteAudioElements.get(peerId);
  }

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
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
  updateParticipantList();
}

function createPeerConnection(peerId, peerName) {
  if (peerConnections.has(peerId)) {
    return peerConnections.get(peerId);
  }

  const pc = new RTCPeerConnection(rtcConfig);

  localStream.getAudioTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal-ice-candidate", {
        to: peerId,
        candidate: event.candidate,
      });
    }
  };

  pc.ontrack = (event) => {
    const audio = ensureAudioElement(peerId);
    audio.srcObject = event.streams[0];
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

  try {
    setStatus("Starting microphone...");
    await startLocalAudio();

    socket = io();

    socket.on("connect", () => {
      currentRoomId = roomId;
      participantState.set(socket.id, {
        userName,
        muted: localMuted,
      });

      socket.emit("join-room", { roomId, userName });
      setStatus("Connected. Waiting for others...");
      updateParticipantList();
    });

    socket.on("room-participants", ({ roomId: joinedRoom, participants }) => {
      activeRoom.textContent = joinedRoom;
      setStatus("Room connected. Voice is live.");

      for (const peer of participants) {
        participantState.set(peer.id, {
          userName: peer.userName,
          muted: peer.muted,
        });
      }

      updateParticipantList();
    });

    socket.on("peer-joined", async ({ id, userName: peerName, muted }) => {
      participantState.set(id, {
        userName: peerName,
        muted,
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

  localMuted = !localMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !localMuted;
  });

  const self = participantState.get(socket.id);
  if (self) {
    self.muted = localMuted;
  }

  socket.emit("mute-state-changed", { muted: localMuted });

  muteBtn.textContent = localMuted ? "Unmute" : "Mute";
  setStatus(localMuted ? "Your mic is muted." : "Your mic is live.");
  updateParticipantList();
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

leaveBtn.addEventListener("click", () => {
  leaveRoom();
});

roomInput.value = randomRoom();
nameInput.value = `Guest-${Math.random().toString(36).slice(2, 5)}`;
updateParticipantList();
