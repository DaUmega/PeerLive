let socket = null;
let localStream = null;
let peerConnection = null;
let role = null;
let roomId = null;
let password = null;
let reconnectInterval = null;
let reconnectAttempts = 0;
let authFailed = false;

const peerConnections = {};
const pendingCandidates = {};

const views = {
    welcome: document.getElementById("welcomeView"),
    stream: document.getElementById("streamView")
};

const buttons = {
    create: document.getElementById("createBtn"),
    join: document.getElementById("joinBtn"),
    startCamera: document.getElementById("startCameraBtn"),
    copyUrl: document.getElementById("copyUrlBtn"),
    exit: document.getElementById("exitStreamBtn"),
    switchCamera: document.getElementById("switchCameraBtn"),
    goBack: document.getElementById("goBackBtn"),
    chatSend: document.getElementById("chatSendBtn"),
    upload: document.getElementById("uploadBtn")
};

const inputs = {
    roomId: document.getElementById("roomId"),
    password: document.getElementById("password"),
    displayName: document.getElementById("displayName"),
    chat: document.getElementById("chatInput"),
    file: document.getElementById("fileInput")
};

const elements = {
    status: document.getElementById("status"),
    localVideo: document.getElementById("localVideo"),
    remoteVideo: document.getElementById("remoteVideo"),
    chatMessages: document.getElementById("chatMessages"),
    sharedFiles: document.getElementById("sharedFiles"),
    chatFileShare: document.getElementById("chatFileShare"),
    localWrapper: document.getElementById("localWrapper"),
    remoteWrapper: document.getElementById("remoteWrapper")
};

let currentVideoDeviceId = null;
let videoInputDevices = [];
const MAX_CHAT_LENGTH = 500;

// Update video section aspect ratio based on actual video dimensions
function updateVideoAspectRatio(video) {
    video.addEventListener("loadedmetadata", () => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height) {
            const ratio = (width / height).toFixed(2);
            const videoSection = document.querySelector(".video-section");
            if (videoSection) {
                videoSection.style.aspectRatio = ratio;
            }
        }
    }, { once: true });
}

// VIEW MANAGEMENT
function showView(viewName) {
    views.welcome.classList.toggle("hidden", viewName !== "welcome");
    views.stream.classList.toggle("hidden", viewName !== "stream");
}

// BUTTONS
buttons.create.onclick = async () => {
    roomId = inputs.roomId.value.trim();
    password = inputs.password.value;
    if (!roomId || !password) {
        alert("Room ID and password required");
        return;
    }
    role = "host";
    try {
        const res = await fetch(`/create/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert("Failed: " + (body?.error || res.status));
            return;
        }
        buttons.startCamera.style.display = "block";
        buttons.copyUrl.style.display = "block";
        elements.status.textContent = `Room created. Start camera to begin.`;
        buttons.copyUrl.onclick = () => {
            const url = `${location.origin}?room=${encodeURIComponent(roomId)}`;
            navigator.clipboard.writeText(url).then(() => 
                alert("URL copied:\n" + url)
            ).catch(() => alert("Copy failed"));
        };
    } catch (err) {
        alert("Error: " + err.message);
    }
};

buttons.join.onclick = () => {
    roomId = inputs.roomId.value.trim();
    password = inputs.password.value;
    if (!roomId || !password) {
        alert("Room ID and password required");
        return;
    }
    role = "viewer";
    authFailed = false;
    connectToRoom(roomId, password);
};

buttons.startCamera.onclick = async () => {
    await startCamera();
    connectToRoom(roomId, password);
};

buttons.exit.onclick = () => {
    if (confirm("Exit stream?")) location.reload();
};

buttons.goBack.onclick = () => {
    window.location.href = "https://daumega.github.io/";
};

buttons.chatSend.onclick = sendChatMessage;
inputs.chat.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
});

inputs.file.addEventListener("change", () => {
    buttons.upload.disabled = !inputs.file.files.length;
});

buttons.upload.onclick = async () => {
    if (!roomId || !inputs.file.files[0]) return;
    buttons.upload.disabled = true;
    try {
        const form = new FormData();
        form.append("file", inputs.file.files[0]);
        const res = await fetch(`/upload/${encodeURIComponent(roomId)}`, {
            method: "POST",
            body: form
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.fileId) {
            alert("Upload failed: " + (data.error || res.status));
        }
    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        buttons.upload.disabled = false;
        inputs.file.value = "";
    }
};

// CAMERA
async function updateVideoInputs() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoInputDevices = devices.filter(d => d.kind === "videoinput");
    } catch (e) {
        videoInputDevices = [];
    }
}

async function startCamera() {
    try {
        const constraints = {
            audio: true,
            video: currentVideoDeviceId
                ? { deviceId: { exact: currentVideoDeviceId } }
                : { facingMode: "user" }
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        elements.localVideo.srcObject = localStream;
        elements.localVideo.style.display = "block";
        updateVideoAspectRatio(elements.localVideo);
        buttons.startCamera.style.display = "none";

        const vTrack = localStream.getVideoTracks()[0];
        currentVideoDeviceId = vTrack?.getSettings?.().deviceId || null;

        await updateVideoInputs();
        if (videoInputDevices.length > 1) {
            buttons.switchCamera.style.display = "block";
        }
    } catch (err) {
        alert("Camera access failed: " + err.message);
    }
}

async function switchCamera() {
    if (!localStream) return;
    await updateVideoInputs();

    let newDeviceId = null;
    if (videoInputDevices.length > 1 && currentVideoDeviceId) {
        const ids = videoInputDevices.map(d => d.deviceId);
        const idx = ids.indexOf(currentVideoDeviceId);
        newDeviceId = ids[(idx + 1) % ids.length];
    }

    let newStream = null;
    if (newDeviceId) {
        try {
            newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: newDeviceId } },
                audio: false
            });
        } catch (e) {
            newStream = null;
        }
    }

    if (!newStream) {
        const currentFacing = localStream.getVideoTracks()[0]?.getSettings?.().facingMode || null;
        const wanted = currentFacing === "environment" ? "user" : "environment";
        try {
            newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: wanted } },
                audio: false
            });
        } catch (e) {
            addChatMessage({ name: "System", message: "Cannot switch camera." });
            return;
        }
    }

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
        addChatMessage({ name: "System", message: "No video track." });
        return;
    }

    const oldVideoTrack = localStream.getVideoTracks()[0];
    localStream.addTrack(newVideoTrack);
    if (oldVideoTrack) {
        localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
    }

    currentVideoDeviceId = newVideoTrack.getSettings?.().deviceId || currentVideoDeviceId;
    elements.localVideo.srcObject = null;
    elements.localVideo.srcObject = localStream;
    elements.localVideo.play().catch(() => {});
    updateVideoAspectRatio(elements.localVideo);

    Object.values(peerConnections).forEach(pc => {
        try {
            const senders = pc.getSenders?.() || [];
            const videoSender = senders.find(s => s.track?.kind === "video");
            if (videoSender?.replaceTrack) {
                videoSender.replaceTrack(newVideoTrack).catch(() => {
                    try { pc.addTrack(newVideoTrack, localStream); } catch (e) {}
                });
            } else {
                try { pc.addTrack(newVideoTrack, localStream); } catch (e) {}
            }
        } catch (e) {}
    });

    newStream.getTracks().forEach(t => { if (t.kind !== "video") t.stop(); });
    await updateVideoInputs();
}

buttons.switchCamera.addEventListener("click", async () => {
    buttons.switchCamera.disabled = true;
    try {
        await switchCamera();
    } finally {
        buttons.switchCamera.disabled = false;
    }
});

// SOCKET
function connectToRoom(roomId, password) {
    if (socket) {
        try {
            socket.removeAllListeners();
            socket.disconnect();
        } catch (e) {}
        socket = null;
    }

    socket = io({ forceNew: true, transports: ["polling", "websocket"] });
    setupSocketHandlers();

    socket.on("connect_error", (err) => {
        elements.status.textContent = "Connection error";
    });

    socket.on("connect", () => {
        const displayName = inputs.displayName.value.trim();
        socket.emit("join", { roomId, password, displayName }, (res) => {
            if (res?.ok) {
                enableStreamMode();
                inputs.roomId.disabled = true;
                inputs.password.disabled = true;
                inputs.displayName.disabled = true;
                elements.chatFileShare.style.display = "block";
                inputs.chat.disabled = false;
                buttons.chatSend.disabled = false;
                authFailed = false;
            } else {
                elements.status.textContent = "Error: " + (res?.error || "Join failed");
                authFailed = true;
                if (socket) {
                    socket.removeAllListeners();
                    socket.disconnect();
                    socket = null;
                }
            }
        });
    });
}

function setupSocketHandlers() {
    socket.on("server-error", (msg) => {
        elements.status.textContent = "Error: " + msg;
        if (typeof msg === "string" && /invalid|password/i.test(msg)) authFailed = true;
        cleanup();
    });

    socket.on("error", (msg) => {
        if (typeof msg === "string") {
            elements.status.textContent = "Error: " + msg;
            if (/invalid|password/i.test(msg)) authFailed = true;
        }
        cleanup();
    });

    socket.on("chat", (payload) => {
        addChatMessage(payload);
    });

    socket.on("file-shared", ({ fileId, name, size }) => {
        const entry = document.createElement("div");
        const link = document.createElement("a");
        link.href = `/download/${encodeURIComponent(fileId)}`;
        link.textContent = `${name} (${(size / 1024).toFixed(1)} KB)`;
        link.target = "_blank";
        entry.appendChild(link);
        elements.sharedFiles.appendChild(entry);
    });

    socket.on("peer-joined", async (peerId) => {
        if (role === "host") {
            const pc = setupConnection();
            peerConnections[peerId] = pc;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("signal", { roomId, data: { sdp: offer }, target: peerId });
        }
    });

    socket.on("signal", async ({ from, data }) => {
        let pc = peerConnections[from];
        if (!pc) {
            pc = setupConnection();
            peerConnections[from] = pc;
        }

        if (data.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type === "offer") {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit("signal", { roomId, data: { sdp: answer }, target: from });
            }
            pendingCandidates[from]?.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)));
            pendingCandidates[from] = [];
        } else if (data.candidate) {
            if (pc.remoteDescription?.type) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } else {
                pendingCandidates[from] = pendingCandidates[from] || [];
                pendingCandidates[from].push(data.candidate);
            }
        }
    });

    socket.on("peer-left", (peerId) => {
        if (peerConnections[peerId]) {
            peerConnections[peerId].close();
            delete peerConnections[peerId];
        }
    });
}

function setupConnection() {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        sdpSemantics: "unified-plan"
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("signal", {
                roomId,
                data: { candidate: event.candidate },
                target: Object.keys(peerConnections).find(k => peerConnections[k] === pc)
            });
        }
    };

    pc.ontrack = (event) => {
        elements.remoteVideo.srcObject = event.streams[0];
        elements.remoteVideo.style.display = "block";
        updateVideoAspectRatio(elements.remoteVideo);
    };

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (["disconnected", "failed", "closed"].includes(state)) {
            if (role === "viewer" && !authFailed) handleHostDisconnected();
        }
    };

    return pc;
}

function handleHostDisconnected() {
    if (reconnectInterval || authFailed) return;
    reconnectAttempts = 0;
    reconnectInterval = setInterval(() => {
        if (authFailed || reconnectAttempts >= 12) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
            return;
        }
        reconnectAttempts++;
        try {
            connectToRoom(roomId, password);
        } catch (e) {}
    }, 10000);
}

// CHAT
function addChatMessage({ from, name, message, time } = {}) {
    if (!elements.chatMessages) return;
    const item = document.createElement("div");
    item.className = "chat-message";

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const t = time ? new Date(time) : new Date();
    const ts = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = (name && name.length) ? decodeHtmlEntities(name) : (from ? from.slice(0, 8) : "unknown");

    const username = document.createElement("span");
    username.className = "chat-username";
    username.textContent = who;
    meta.appendChild(username);

    const timestamp = document.createElement("span");
    timestamp.className = "chat-timestamp";
    timestamp.textContent = ts;
    meta.appendChild(timestamp);

    const text = document.createElement("div");
    text.className = "chat-text";
    text.textContent = decodeHtmlEntities(message || "");

    item.appendChild(meta);
    item.appendChild(text);
    elements.chatMessages.appendChild(item);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function decodeHtmlEntities(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.innerHTML = str;
    return div.textContent;
}

function sendChatMessage() {
    if (!socket || socket.disconnected) return;
    const msg = inputs.chat.value.trim().slice(0, MAX_CHAT_LENGTH);
    if (!msg) return;
    socket.emit("chat", { roomId, message: msg }, (res) => {
        if (res?.ok) {
            inputs.chat.value = "";
        } else {
            addChatMessage({ name: "System", message: res?.error || "Failed" });
        }
    });
}

// FULLSCREEN
function enableFullscreenOnClick(video) {
    video.addEventListener("click", () => {
        if (video.requestFullscreen) video.requestFullscreen();
        else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
        else if (video.msRequestFullscreen) video.msRequestFullscreen();
    });
}

enableFullscreenOnClick(elements.localVideo);
enableFullscreenOnClick(elements.remoteVideo);

// STREAM MODE
function enableStreamMode() {
    showView("stream");
    document.querySelector(".stream-layout").dataset.role = role;
    buttons.create.style.display = "none";
    buttons.join.style.display = "none";
}

function cleanup() {
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    Object.values(peerConnections).forEach(pc => pc.close());
    for (const k in peerConnections) delete peerConnections[k];

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        elements.localVideo.srcObject = null;
    }
    elements.remoteVideo.srcObject = null;

    currentVideoDeviceId = null;
    videoInputDevices = [];
    buttons.switchCamera.style.display = "none";
    buttons.startCamera.style.display = "block";
    buttons.copyUrl.style.display = "none";
    inputs.roomId.disabled = false;
    inputs.password.disabled = false;
    inputs.displayName.disabled = false;
    elements.chatMessages.innerHTML = "";
    inputs.chat.value = "";
    inputs.chat.disabled = true;
    buttons.chatSend.disabled = true;
    elements.chatFileShare.style.display = "none";
    elements.sharedFiles.innerHTML = "";
    showView("welcome");
}

// INIT
window.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room) inputs.roomId.value = room;
});

