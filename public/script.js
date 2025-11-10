let socket = null;
let localStream = null;
let peerConnection = null;
let role = null;
let roomId = null;
let password = null;

let reconnectInterval = null;
let reconnectAttempts = 0;
let authFailed = false;

const peerConnections = {}; // peerId -> RTCPeerConnection
const pendingCandidates = {}; // peerId -> ICE candidate queue

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const startCameraBtn = document.getElementById("startCameraBtn");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const statusEl = document.getElementById("status");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const displayNameInput = document.getElementById("displayName");
const chatPanel = document.getElementById("chatPanel");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const chatToggle = document.getElementById("chatToggle");
const chatFullscreenBtn = document.getElementById("chatFullscreenBtn");
const exitBtn = document.getElementById("exitStreamBtn");
const goBackBtn = document.getElementById("goBackBtn");
let switchCameraBtn = document.getElementById("switchCameraBtn");

const localWrapper = document.getElementById("localWrapper");
const remoteWrapper = document.getElementById("remoteWrapper");

let currentVideoDeviceId = null;
let videoInputDevices = [];

const MAX_CHAT_LENGTH = 500;

if (chatPanel) {
    chatPanel.style.display = "none";
}
if (chatInput) {
    chatInput.disabled = true;
}
if (chatSendBtn) {
    chatSendBtn.disabled = true;
}

createBtn.onclick = async () => {
    roomId = document.getElementById("roomId").value.trim();
    password = document.getElementById("password").value;

    if (!roomId || !password) {
        alert("Room ID and password are required");
        return;
    }

    role = "host";
    try {
        const res = await fetch(`/create/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });

        let body;
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            body = await res.json();
        } else {
            const text = await res.text();
            try {
                body = JSON.parse(text);
            } catch {
                body = { error: text };
            }
        }

        if (!res.ok) {
            alert("Room creation failed: " + (body?.error || `HTTP ${res.status}`));
            return;
        }

        startCameraBtn.style.display = "block";
        copyUrlBtn.style.display = "block";
        statusEl.textContent = `Room ${roomId} created. Start camera to begin streaming.`;

        copyUrlBtn.onclick = () => {
            const url = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
            navigator.clipboard.writeText(url)
                .then(() => alert("Room URL copied to clipboard:\n" + url))
                .catch(err => alert("Failed to copy URL: " + err));
        };
        // show switch button for hosts only when camera started (hidden until camera active)
        if (switchCameraBtn) switchCameraBtn.style.display = "none";
    } catch (err) {
        alert("Failed to create room: " + err.message);
    }
};

joinBtn.onclick = () => {
    roomId = document.getElementById("roomId").value.trim();
    password = document.getElementById("password").value;

    if (!roomId || !password) {
        alert("Room ID and password are required");
        return;
    }

    role = "viewer";
    authFailed = false;
    connectToRoom(roomId, password);
};

startCameraBtn.onclick = async () => {
    await startCamera();
    enableStreamMode();
    connectToRoom(roomId, password);
};

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
        // prefer existing device id if known (e.g., when switching)
        const constraints = { audio: true, video: currentVideoDeviceId ? { deviceId: { exact: currentVideoDeviceId } } : { facingMode: "user" } };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        localVideo.style.display = "block";
        if (localWrapper && localWrapper.classList.contains("hidden")) {
            localWrapper.classList.remove("hidden");
        }
        startCameraBtn.style.display = "none";

        // determine current video device id
        const vTrack = localStream.getVideoTracks()[0];
        currentVideoDeviceId = vTrack?.getSettings?.().deviceId || null;

        await updateVideoInputs();
        if (switchCameraBtn) {
            // show switch button only if multiple video devices are present
            if (videoInputDevices.length > 1) {
                switchCameraBtn.style.display = "block";
                switchCameraBtn.disabled = false;
            } else {
                // still allow toggle by facingMode if only one device id but device supports facingMode change
                switchCameraBtn.style.display = "block";
                switchCameraBtn.disabled = false;
            }
        }
    } catch (err) {
        alert("Failed to access camera: " + err.message);
    }
}

async function switchCamera() {
    if (!navigator.mediaDevices || !localStream) return;

    await updateVideoInputs();

    let newDeviceId = null;

    if (videoInputDevices.length > 1 && currentVideoDeviceId) {
        // cycle to next device in list
        const ids = videoInputDevices.map(d => d.deviceId);
        const idx = ids.indexOf(currentVideoDeviceId);
        const next = (idx >= 0) ? (idx + 1) % ids.length : 0;
        newDeviceId = ids[next];
    } else if (videoInputDevices.length > 1 && !currentVideoDeviceId) {
        newDeviceId = videoInputDevices[0].deviceId;
    }

    // try deviceId switch first when available
    let newStream = null;
    if (newDeviceId) {
        try {
            newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: newDeviceId } }, audio: false });
        } catch (e) {
            console.warn("Switch by deviceId failed, will try facingMode toggle:", e);
            newStream = null;
        }
    }

    // fallback: try toggling facingMode
    if (!newStream) {
        // determine current facing if possible
        const currentFacing = localStream.getVideoTracks()[0]?.getSettings?.().facingMode || null;
        const wanted = (currentFacing === "environment") ? "user" : "environment";
        try {
            newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: wanted } }, audio: false });
        } catch (e) {
            console.warn("Switch by facingMode failed:", e);
            // nothing to do if both fail
            appendChatMessage({ name: "System", message: "Unable to switch camera.", time: Date.now() });
            return;
        }
    }

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
        appendChatMessage({ name: "System", message: "No video track available when switching camera.", time: Date.now() });
        return;
    }

    // Replace track in localStream
    const oldVideoTrack = localStream.getVideoTracks()[0];
    try {
        // add new track then remove old (keeps stream id stable in some browsers)
        localStream.addTrack(newVideoTrack);
        if (oldVideoTrack) {
            localStream.removeTrack(oldVideoTrack);
            oldVideoTrack.stop();
        }
    } catch (e) {
        console.warn("Replacing tracks on MediaStream failed:", e);
    }

    // update current device id if available
    currentVideoDeviceId = newVideoTrack.getSettings?.().deviceId || currentVideoDeviceId;

    // update UI
    localVideo.srcObject = null;
    localVideo.srcObject = localStream;
    localVideo.play().catch(()=>{});

    // inform peers: replace sender's track where possible
    Object.values(peerConnections).forEach(pc => {
        try {
            const senders = pc.getSenders ? pc.getSenders() : [];
            const videoSender = senders.find(s => s.track && s.track.kind === "video");
            if (videoSender && videoSender.replaceTrack) {
                videoSender.replaceTrack(newVideoTrack).catch(err => {
                    console.warn("replaceTrack failed, attempting to remove/add:", err);
                    // fallback: remove old sender track by adding new track directly
                    try {
                        pc.addTrack(newVideoTrack, localStream);
                    } catch (e) { /* best-effort */ }
                });
            } else {
                // fallback: add new track
                try {
                    pc.addTrack(newVideoTrack, localStream);
                } catch (e) { /* ignore */ }
            }
        } catch (e) {
            console.warn("Error updating peer sender for new video track:", e);
        }
    });

    // stop the temporary stream's audio (none requested) and cleanup (if any leftover tracks)
    newStream.getTracks().forEach(t => {
        if (t.kind !== "video") t.stop();
    });

    // refresh input list (some browsers report different device ids after change)
    await updateVideoInputs();
}

// wire up switch button
if (switchCameraBtn) {
    switchCameraBtn.addEventListener("click", async () => {
        switchCameraBtn.disabled = true;
        try {
            await switchCamera();
        } finally {
            switchCameraBtn.disabled = false;
        }
    });
}

function connectToRoom(roomId, password) {
    if (socket) {
        try {
            socket.removeAllListeners();
            socket.disconnect();
        } catch (e) {
            console.warn("Error while disconnecting previous socket:", e);
        }
        socket = null;
    }

    socket = io({ forceNew: true, transports: ["polling", "websocket"] });
    setupSocketHandlers();

    socket.on("connect_error", (err) => {
        console.warn("Socket connect_error:", err);
        statusEl.textContent = "Connection error: " + (err && err.message ? err.message : err);
    });

    socket.on("connect", () => {
        const displayName = (displayNameInput && displayNameInput.value) ? displayNameInput.value.trim() : "";

        socket.emit("join", { roomId, password, displayName }, (res) => {
            if (res && res.ok) {
                createBtn.style.display = "none";
                joinBtn.style.display = "none";
                enableStreamMode();
                document.getElementById("roomId").disabled = true;
                document.getElementById("password").disabled = true;
                if (displayNameInput) displayNameInput.disabled = true;
                statusEl.textContent = "";
                authFailed = false;

                if (chatPanel) chatPanel.style.display = "";
                if (chatInput) chatInput.disabled = false;
                if (chatSendBtn) chatSendBtn.disabled = false;
            } else {
                statusEl.textContent = "Error: " + (res?.error || "Join failed");
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
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.style.display = "block";
        if (remoteWrapper && remoteWrapper.classList.contains("hidden")) {
            remoteWrapper.classList.remove("hidden");
        }
    };

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log("Peer connection state:", state);
        if (state === "disconnected" || state === "failed" || state === "closed") {
            statusEl.textContent = "Connection lost. Attempting to reconnect...";
            if (role === "viewer" && !authFailed) {
                handleHostDisconnected();
            }
        }
    };

    return pc;
}

function setupSocketHandlers() {
    socket.on("server-error", (msg) => {
        console.warn("Server error:", msg);
        statusEl.textContent = "Error: " + msg;
        if (typeof msg === "string" && (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("password"))) {
            authFailed = true;
        }
        cleanupAndResetUI();
    });

    socket.on("error", (msg) => {
        console.warn("Socket error:", msg);
        if (typeof msg === "string") {
            statusEl.textContent = "Error: " + msg;
            if (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("password")) {
                authFailed = true;
            }
        }
        cleanupAndResetUI();
    });

    socket.on("chat", (payload) => {
        appendChatMessage(payload);
    });

    socket.on("peer-joined", async (peerId) => {
        statusEl.textContent = `Peer ${peerId} joined.`;

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
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } else {
                pendingCandidates[from] = pendingCandidates[from] || [];
                pendingCandidates[from].push(data.candidate);
            }
        }
    });

    socket.on("peer-left", (peerId) => {
        statusEl.textContent = `Peer ${peerId} left.`;
        if (peerConnections[peerId]) {
            peerConnections[peerId].close();
            delete peerConnections[peerId];
        }
    });
}

function handleHostDisconnected() {
    if (reconnectInterval || authFailed) return;
    reconnectAttempts = 0;
    statusEl.textContent = "Host disconnected. Waiting to reconnect...";

    reconnectInterval = setInterval(() => {
        if (authFailed) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
            return;
        }
        if (reconnectAttempts >= 12) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
            statusEl.textContent = "Host did not reconnect within 2 minutes.";
            return;
        }
        reconnectAttempts++;
        console.log(`Reconnect attempt ${reconnectAttempts}`);

        try {
            connectToRoom(roomId, password);
        } catch (e) {
            console.warn("Reconnect attempt failed to start:", e);
        }
    }, 10000);
}

function decodeHtmlEntities(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.innerHTML = str;
    return div.textContent;
}

function appendChatMessage({ from, name, message, time } = {}) {
    if (!chatMessages) return;
    const item = document.createElement("div");
    item.className = "chat-message";

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const t = time ? new Date(time) : new Date();
    const ts = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const who = (name && name.length) ? decodeHtmlEntities(name) : (from ? from.slice(0, 8) : "unknown");
    meta.textContent = `${ts} • ${who}`;

    const text = document.createElement("div");
    const decoded = decodeHtmlEntities(message || "");
    text.textContent = decoded;

    item.appendChild(meta);
    item.appendChild(text);
    chatMessages.appendChild(item);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendChatMessage() {
    if (!socket || socket.disconnected) return;
    const raw = (chatInput.value || "").trim();
    if (!raw) return;
    const msg = raw.slice(0, MAX_CHAT_LENGTH);
    socket.emit("chat", { roomId, message: msg }, (res) => {
        if (res && res.ok) {
            chatInput.value = "";
        } else {
            const err = res?.error || "Failed to send";
            appendChatMessage({ name: "System", message: err, time: Date.now() });
        }
    });
}

if (chatSendBtn) {
    chatSendBtn.addEventListener("click", sendChatMessage);
}

if (chatInput) {
    chatInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            sendChatMessage();
        }
    });
}

if (chatToggle) {
    chatToggle.addEventListener("click", () => {
        if (!chatPanel) return;
        chatPanel.classList.toggle("collapsed");
        chatToggle.textContent = chatPanel.classList.contains("collapsed") ? "+" : "─";
    });
}

if (chatFullscreenBtn) {
    chatFullscreenBtn.addEventListener("click", async () => {
        if (!chatPanel) return;

        // detect whether chatPanel is currently fullscreen (standard + vendor prefixes)
        const isStdFullscreen = document.fullscreenElement === chatPanel;
        const isWebkitFullscreen = document.webkitFullscreenElement === chatPanel;
        const isMsFullscreen = document.msFullscreenElement === chatPanel;
        const isCurrentlyFullscreen = !!(isStdFullscreen || isWebkitFullscreen || isMsFullscreen);

        // If Fullscreen API is available prefer it so user can press ESC to exit.
        const supportsFullscreen = !!(chatPanel.requestFullscreen || chatPanel.webkitRequestFullscreen || chatPanel.msRequestFullscreen);

        try {
            if (supportsFullscreen) {
                if (isCurrentlyFullscreen) {
                    if (document.exitFullscreen) await document.exitFullscreen();
                    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
                    else if (document.msExitFullscreen) await document.msExitFullscreen();
                    document.body.classList.remove("chat-fullscreen-active");
                } else {
                    if (chatPanel.requestFullscreen) await chatPanel.requestFullscreen();
                    else if (chatPanel.webkitRequestFullscreen) await chatPanel.webkitRequestFullscreen();
                    else if (chatPanel.msRequestFullscreen) await chatPanel.msRequestFullscreen();
                    // when chat is fullscreen hide other UI (video/controls)
                    document.body.classList.add("chat-fullscreen-active");
                }
            } else {
                // fallback: toggle CSS fullscreen class + hide other UI
                const now = chatPanel.classList.toggle("fullscreen");
                document.body.classList.toggle("chat-fullscreen-active", now);
            }
        } catch (err) {
            console.warn("Fullscreen toggle failed:", err);
        }
    });

    // Keep body class in sync if user exits fullscreen via ESC or other UI.
    const onFsChange = () => {
        const isStd = document.fullscreenElement === chatPanel;
        const isWebkit = document.webkitFullscreenElement === chatPanel;
        const isMs = document.msFullscreenElement === chatPanel;
        const active = !!(isStd || isWebkit || isMs);
        document.body.classList.toggle("chat-fullscreen-active", active);
        // if not active, also remove fallback class
        if (!active && chatPanel.classList.contains("fullscreen")) {
            chatPanel.classList.remove("fullscreen");
        }
    };

    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    document.addEventListener("msfullscreenchange", onFsChange);
}

function cleanupAndResetUI() {
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

    if (localVideo) {
        localVideo.srcObject = null;
        localVideo.style.display = "none";
        if (localWrapper && !localWrapper.classList.contains("hidden")) {
            localWrapper.classList.add("hidden");
        }
    }
    if (remoteVideo) {
        remoteVideo.srcObject = null;
        remoteVideo.style.display = "none";
        if (remoteWrapper && !remoteWrapper.classList.contains("hidden")) {
            remoteWrapper.classList.add("hidden");
        }
    }

    // reset camera switch state
    currentVideoDeviceId = null;
    videoInputDevices = [];
    if (switchCameraBtn) {
        switchCameraBtn.style.display = "none";
        switchCameraBtn.disabled = true;
    }

    startCameraBtn.style.display = "none";
    copyUrlBtn.style.display = "none";
    createBtn.style.display = "block";
    joinBtn.style.display = "block";
    document.getElementById("roomId").disabled = false;
    document.getElementById("password").disabled = false;
    if (displayNameInput) displayNameInput.disabled = false;

    if (chatMessages) chatMessages.innerHTML = "";
    if (chatInput) {
        chatInput.value = "";
        chatInput.disabled = true;
    }
    if (chatSendBtn) chatSendBtn.disabled = true;
    if (chatPanel) {
        chatPanel.classList.remove("collapsed");
        chatPanel.style.display = "none";
    }
}

function enableFullscreenOnClick(videoElement) {
    videoElement.addEventListener("click", () => {
        if (videoElement.requestFullscreen) videoElement.requestFullscreen();
        else if (videoElement.webkitRequestFullscreen) videoElement.webkitRequestFullscreen();
        else if (videoElement.msRequestFullscreen) videoElement.msRequestFullscreen();
    });
}

// Function to enable livestream mode
function enableStreamMode() {
    document.body.classList.add("stream-active");
    if (goBackBtn) goBackBtn.style.display = "none";
    if (exitBtn) exitBtn.classList.remove("hidden");
    if (switchCameraBtn && role === "host") {
        switchCameraBtn.style.display = "block";
        switchCameraBtn.disabled = false;
    }
}

// Function to disable livestream mode (refresh after confirm)
function setupExitButton() {
    if (!exitBtn) return;
    exitBtn.addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.background = "rgba(0,0,0,0.6)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.zIndex = "2000";

        const box = document.createElement("div");
        box.style.background = "#fff";
        box.style.color = "#111";
        box.style.padding = "20px 30px";
        box.style.borderRadius = "10px";
        box.style.textAlign = "center";
        box.innerHTML = `
            <p style="margin-bottom:15px;">Are you sure you want to exit the stream?</p>
            <button id="confirmExitBtn" style="margin-right:10px; padding:8px 16px; border:none; border-radius:8px; background:#ef4444; color:#fff; cursor:pointer;">Exit</button>
            <button id="cancelExitBtn" style="padding:8px 16px; border:none; border-radius:8px; background:#94a3b8; color:#fff; cursor:pointer;">Cancel</button>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        document.getElementById("confirmExitBtn").onclick = () => location.reload();
        document.getElementById("cancelExitBtn").onclick = () => overlay.remove();
    });
}

setupExitButton();

goBackBtn.addEventListener("click", () => {
    window.location.href = "https://daumega.github.io/";
});

enableFullscreenOnClick(localVideo);
enableFullscreenOnClick(remoteVideo);

window.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const prefillRoom = params.get("room");
    if (prefillRoom) document.getElementById("roomId").value = prefillRoom;

    if (localWrapper && !localWrapper.classList.contains("hidden")) localWrapper.classList.add("hidden");
    if (remoteWrapper && !remoteWrapper.classList.contains("hidden")) remoteWrapper.classList.add("hidden");
});
