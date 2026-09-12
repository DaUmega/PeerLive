"use strict";

const $ = (id) => document.getElementById(id);
const peers = new Map();
const announcedStreams = new Map();
const sharedFileIds = new Set();
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let socket;
let roomId;
let password;
let owner = false;
let localStream;
let localVideo;
let joining = false;
let everJoined = false;
let confirmation;
let roomMemberCount = 0;

const status = (text) => { $("status").textContent = text; };
const displayName = () => $("displayName").value.trim() || (owner ? "Room owner" : "Guest");
const roomUrl = () => `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (value) => value.toString(36).padStart(2, "0")).join("").slice(0, 12);

function appendMessage(element) {
  $("messages").appendChild(element);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function addMessage(sender, text, time = Date.now()) {
  const row = document.createElement("div");
  row.className = "message";
  const name = document.createElement("b");
  name.textContent = `${sender} `;
  const body = document.createElement("span");
  body.textContent = text;
  const clock = document.createElement("time");
  clock.textContent = ` ${new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  row.append(name, body, clock);
  appendMessage(row);
}

function addNotice(text) {
  const row = document.createElement("div");
  row.className = "message notice";
  row.textContent = text;
  appendMessage(row);
}

function addFileMessage(fileId, name, size) {
  const row = document.createElement("div");
  row.className = "message";
  const link = document.createElement("a");
  link.href = `/download/${encodeURIComponent(fileId)}`;
  link.textContent = `Download ${name} (${(size / 1024).toFixed(1)} KB)`;
  row.appendChild(link);
  appendMessage(row);
}

function updatePeerCount() {
  const guests = Math.max(0, roomMemberCount - 1);
  $("peers").textContent = `${guests} guest${guests === 1 ? "" : "s"} connected`;
}

function addVideo(stream, label, muted) {
  const wrap = document.createElement("div");
  wrap.className = "video-wrap";
  const caption = document.createElement("span");
  caption.textContent = label;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  video.addEventListener("click", () => video.requestFullscreen?.());
  wrap.append(caption, video);
  $("videos").appendChild(wrap);
  return wrap;
}

function setJoining(value) {
  joining = value;
  $("createRoom").disabled = value;
  $("joinRoom").disabled = value;
}

function showSetup(mode) {
  $("start").hidden = true;
  $("setup").hidden = false;
  $("createPanel").hidden = mode !== "create";
  $("joinPanel").hidden = mode !== "join";
  status(mode === "create" ? "Choose a room name and password." : "Enter the room code and password from its owner.");
}

function enterRoom() {
  $("room").hidden = false;
  $("setup").hidden = true;
  $("start").hidden = true;
  updatePeerCount();
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peers.delete(peerId);
  peer.streams.forEach((stream) => removeRemoteStream(peer, stream.id));
  peer.pc.close();
  updatePeerCount();
}

function updateWatchLabel(peer, streamId) {
  const entry = peer.streams.get(streamId);
  if (entry?.watch) entry.watch.textContent = `${entry.name || "Guest"} started streaming - Watch`;
}

function offerToWatch(peer, stream) {
  const pendingId = [...peer.streams.entries()].find(([, entry]) => !entry.stream)?.[0];
  const streamId = peer.streams.has(stream.id) ? stream.id : pendingId || stream.id;
  const entry = peer.streams.get(streamId) || createStreamEntry(peer, streamId);
  if (entry.stream) return;
  entry.stream = stream;
  entry.watch.disabled = false;
  entry.watch.textContent = `${entry.name} started streaming - Watch`;
}

function createStreamEntry(peer, streamId) {
  const entry = { id: streamId, stream: undefined, name: peer.names.get(streamId) || "Guest", watch: undefined, video: undefined, stop: undefined };
  const watch = document.createElement("button");
  watch.className = "secondary";
  entry.watch = watch;
  watch.textContent = `${entry.name} is preparing their stream...`;
  watch.disabled = true;
  watch.addEventListener("click", () => {
    if (!entry.stream) return;
    entry.video = addVideo(entry.stream, entry.name, false);
    const stop = document.createElement("button");
    stop.className = "secondary";
    stop.textContent = `Stop watching ${entry.name}`;
    entry.stop = stop;
    stop.addEventListener("click", () => {
      entry.video?.remove();
      entry.video = undefined;
      stop.remove();
      entry.stop = undefined;
      watch.hidden = false;
    });
    watch.hidden = true;
    $("streamNotices").appendChild(stop);
  });
  peer.streams.set(streamId, entry);
  $("streamNotices").appendChild(watch);
  return entry;
}

function removeRemoteStream(peer, streamId) {
  const entry = peer.streams.get(streamId);
  if (!entry) return;
  entry.video?.remove();
  entry.watch?.remove();
  entry.stop?.remove();
  peer.streams.delete(streamId);
}

function createPeer(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    pc,
    candidates: [],
    streams: new Map(),
    names: new Map(announcedStreams.get(peerId)),
    makingOffer: false,
    needsNegotiation: false,
    ignoreOffer: false,
    restarted: false,
    polite: socket.id > peerId
  };
  peers.set(peerId, peer);
  updatePeerCount();

  localStream?.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket?.emit("signal", { roomId, target: peerId, data: { candidate } });
  };
  pc.onnegotiationneeded = () => negotiate(peerId, peer);
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === "stable" && peer.needsNegotiation) negotiate(peerId, peer);
  };
  pc.ontrack = ({ streams, track }) => {
    const stream = streams[0] || new MediaStream([track]);
    offerToWatch(peer, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      peer.restarted = false;
    } else if (pc.connectionState === "failed") {
      // try a single ICE restart before giving up - avoids killing the call on a transient blip
      if (!peer.restarted) { peer.restarted = true; negotiate(peerId, peer, true); }
      else removePeer(peerId);
    } else if (pc.connectionState === "closed") {
      removePeer(peerId);
    }
  };
  return peer;
}

async function negotiate(peerId, peer, iceRestart = false) {
  const { pc } = peer;
  if (peer.makingOffer || pc.signalingState !== "stable") {
    peer.needsNegotiation = true;
    return;
  }
  peer.needsNegotiation = false;
  peer.makingOffer = true;
  try {
    await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
    socket.emit("signal", { roomId, target: peerId, data: { sdp: pc.localDescription } });
  } finally {
    peer.makingOffer = false;
  }
}

async function offerPeer(peerId) {
  const peer = peers.get(peerId) || createPeer(peerId);
  await negotiate(peerId, peer);
}

async function handleSignal({ from, data }) {
  const peer = peers.get(from) || createPeer(from);
  const { pc } = peer;
  if (data.sdp) {
    const offerCollision = data.sdp.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    if (offerCollision) {
      await Promise.all([
        pc.setLocalDescription({ type: "rollback" }),
        pc.setRemoteDescription(data.sdp)
      ]);
    } else {
      await pc.setRemoteDescription(data.sdp);
    }
    await Promise.all(peer.candidates.splice(0).map((candidate) => pc.addIceCandidate(candidate)));
    if (data.sdp.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      socket.emit("signal", { roomId, target: from, data: { sdp: pc.localDescription } });
    }
    if (pc.signalingState === "stable" && peer.needsNegotiation) await negotiate(from, peer);
  } else if (data.candidate) {
    if (peer.ignoreOffer) return;
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else peer.candidates.push(data.candidate);
  }
}

function handleStreamEvent({ from, name, streamId, type }) {
  const announcements = announcedStreams.get(from) || new Map();
  announcedStreams.set(from, announcements);
  const peer = peers.get(from);
  if (type === "stream-start") {
    announcements.set(streamId, name || "Guest");
    if (!peer) return addNotice(`${name || "Guest"} started streaming.`);
    peer.names.set(streamId, name || "Guest");
    const entry = peer.streams.get(streamId) || createStreamEntry(peer, streamId);
    entry.name = name || "Guest";
    if (entry.stream) updateWatchLabel(peer, streamId);
    else entry.watch.textContent = `${entry.name} is preparing their stream...`;
    addNotice(`${name || "Guest"} started streaming.`);
  } else {
    announcements.delete(streamId);
    if (peer) removeRemoteStream(peer, streamId);
    addNotice(`${name || "Guest"} stopped streaming.`);
  }
}

function failJoin(text) {
  setJoining(false);
  status(text);
  socket?.disconnect();
}

function connect() {
  socket?.disconnect();
  setJoining(true);
  everJoined = false;
  status("Connecting to the room server...");
  socket = io({ forceNew: true, transports: ["polling", "websocket"] });
  socket.on("connect", () => {
    status(everJoined ? "Reconnecting..." : "Joining room...");
    socket.timeout(10000).emit("join", { roomId, password, displayName: displayName() }, (error, result) => {
      if (error || !result?.ok) {
        const reason = error ? "The room server did not respond." : (result?.error || "unknown error");
        if (!everJoined) return failJoin(`Could not join: ${reason}`);
        status(`Reconnect failed (${reason}). Retrying...`);
        return;
      }
      everJoined = true;
      setJoining(false);
      enterRoom();
      status("Connected. You can chat, share files, or start a camera stream.");
    });
  });
  socket.on("connect_error", () => failJoin("Could not reach the room server. Check your connection and try again."));
  socket.on("server-error", (text) => joining ? failJoin(`Could not join: ${text}`) : status(`Error: ${text}`));
  socket.on("peer-joined", (peerId) => offerPeer(peerId).catch(() => status("Could not connect to a guest.")));
  socket.on("peer-left", removePeer);
  socket.on("room-presence", ({ count }) => { roomMemberCount = count; updatePeerCount(); });
  socket.on("signal", (signal) => handleSignal(signal).catch(() => status("Could not update the peer connection.")));
  socket.on("stream-event", handleStreamEvent);
  socket.on("chat", ({ name, message, time }) => addMessage(name || "Guest", message, time));
  socket.on("file-shared", ({ fileId, name, size }) => {
    if (typeof fileId !== "string" || typeof name !== "string" || !Number.isFinite(size)) return;
    if (sharedFileIds.has(fileId)) return; // already shown locally when we uploaded it
    addFileMessage(fileId, name, size);
  });
  socket.on("disconnect", (reason) => { if (!joining && reason !== "io client disconnect" && roomId) status("Disconnected from the room server."); });
}

async function createRoom() {
  const requested = $("roomName").value.trim();
  const chosenPassword = $("roomPassword").value;
  if (!chosenPassword) return status("Choose a room password first.");
  roomId = requested ? requested.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) : roomCode();
  password = chosenPassword;
  owner = true;
  setJoining(true);
  status("Creating room...");
  try {
    const response = await fetch(`/create/${encodeURIComponent(roomId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create room.");
    $("inviteUrl").value = roomUrl();
    $("inviteDetails").hidden = false;
    connect();
  } catch (error) {
    roomId = password = undefined;
    owner = false;
    setJoining(false);
    status(error.message);
  }
}

function joinRoom() {
  roomId = $("joinRoomId").value.trim();
  password = $("joinPassword").value;
  owner = false;
  if (!roomId || !password) return status("Enter both a room code and password.");
  connect();
}

async function toggleCamera() {
  if (localStream) {
    const streamId = localStream.id;
    peers.forEach(({ pc }) => pc.getSenders().forEach((sender) => { if (sender.track && localStream.getTracks().includes(sender.track)) pc.removeTrack(sender); }));
    localStream.getTracks().forEach((track) => track.stop());
    localStream = undefined;
    localVideo?.remove();
    localVideo = undefined;
    socket.emit("stream-event", { roomId, type: "stream-stop", streamId });
    $("cameraBtn").textContent = "Enable camera";
    status("Camera disabled.");
    return;
  }
  try {
    status("Requesting camera access...");
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo = addVideo(localStream, "You", true);
    peers.forEach(({ pc }) => localStream.getTracks().forEach((track) => pc.addTrack(track, localStream)));
    socket.emit("stream-event", { roomId, type: "stream-start", streamId: localStream.id });
    $("cameraBtn").textContent = "Disable camera";
    status("Camera enabled. Everyone can choose whether to watch.");
  } catch (error) {
    localStream = undefined;
    status(`Camera unavailable: ${error.message}`);
  }
}

async function shareFile(file) {
  const form = new FormData();
  form.append("file", file);
  status(`Sharing ${file.name}...`);
  try {
    const response = await fetch(`/upload/${encodeURIComponent(roomId)}`, { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed.");
    sharedFileIds.add(result.fileId);
    addFileMessage(result.fileId, result.name ?? file.name, result.size ?? file.size);
    status("File shared. It expires in 30 minutes.");
  } catch (error) {
    status(error.message);
  }
}

function resetRoom() {
  [...peers.keys()].forEach(removePeer);
  socket?.disconnect();
  socket = undefined;
  announcedStreams.clear();
  sharedFileIds.clear();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = undefined;
  localVideo?.remove();
  localVideo = undefined;
  roomId = password = undefined;
  owner = false;
  roomMemberCount = 0;
  everJoined = false;
  setJoining(false);
  $("messages").replaceChildren();
  $("videos").replaceChildren();
  $("streamNotices")?.replaceChildren();
  $("room").hidden = true;
  $("setup").hidden = true;
  $("start").hidden = false;
  $("confirm").hidden = true;
  $("cameraBtn").textContent = "Enable camera";
}

async function copyInvite(value) {
  try {
    await navigator.clipboard.writeText(value);
    status("Invite link copied. Share the password separately.");
  } catch {
    status("Copy failed. Select the link and copy it manually.");
  }
}

$("showCreate").onclick = () => showSetup("create");
$("showJoin").onclick = () => showSetup("join");
$("createRoom").onclick = createRoom;
$("joinRoom").onclick = joinRoom;
$("copyInvite").onclick = () => copyInvite($("inviteUrl").value);
$("copyRoomInvite").onclick = () => copyInvite(roomUrl());
$("cameraBtn").onclick = toggleCamera;
$("shareFile").onclick = () => $("fileInput").click();
$("fileInput").onchange = ({ target }) => { if (target.files[0]) shareFile(target.files[0]); target.value = ""; };
$("leaveRoom").onclick = () => { confirmation = () => { resetRoom(); status("You left the room."); }; $("confirmText").textContent = "Leave this room?"; $("confirm").hidden = false; };
$("confirmYes").onclick = () => confirmation?.();
$("confirmNo").onclick = () => { confirmation = undefined; $("confirm").hidden = true; };
$("messageForm").onsubmit = (event) => {
  event.preventDefault();
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text || !socket?.connected) return;
  socket.emit("chat", { roomId, message: text }, (result) => { if (!result?.ok) status(result?.error || "Message was not sent."); });
  input.value = "";
};

window.addEventListener("DOMContentLoaded", () => {
  const sharedRoom = new URLSearchParams(location.search).get("room");
  if (sharedRoom) {
    $("joinRoomId").value = sharedRoom;
    showSetup("join");
  }
});