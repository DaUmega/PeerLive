"use strict";
const $ = (id) => document.getElementById(id);
const peers = new Map();
const rtc = { iceServers: [{ urls:"stun:stun.l.google.com:19302" }, { urls:"stun:stun1.l.google.com:19302" }] };
let socket, roomId, password, owner = false, stream, localVideo, confirmation, joining = false;
const status = (text) => { $("status").textContent = text; };
const name = () => $("displayName").value.trim() || (owner ? "Room owner" : "Guest");
const roomUrl = () => `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), n => n.toString(36).padStart(2,"0")).join("").slice(0,12);
function message(who, text, time = Date.now()) { const row=document.createElement("div"), label=document.createElement("b"), body=document.createElement("span"), clock=document.createElement("time"); row.className="message"; label.textContent=`${who} `; body.textContent=text; clock.textContent=` ${new Date(time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`; row.append(label,body,clock); $("messages").append(row); $("messages").scrollTop=$("messages").scrollHeight; }
function notice(text) { const row=document.createElement("div"); row.className="message notice"; row.textContent=text; $("messages").append(row); $("messages").scrollTop=$("messages").scrollHeight; }
function count() { const n=peers.size; $("peers").textContent=`${n} guest${n===1?"":"s"} connected`; }
function video(media, label, muted) { const wrap=document.createElement("div"), caption=document.createElement("span"), element=document.createElement("video"); wrap.className="video-wrap"; caption.textContent=label; element.autoplay=true; element.playsInline=true; element.muted=muted; element.srcObject=media; element.onclick=()=>element.requestFullscreen?.(); wrap.append(caption,element); $("videos").append(wrap); return wrap; }
function show(mode) { $("start").hidden=true; $("setup").hidden=false; $("createPanel").hidden=mode!=="create"; $("joinPanel").hidden=mode!=="join"; status(mode==="create"?"Choose a room name and password.":"Enter the room code and password from its owner."); }
function enter() { $("room").hidden=false; $("setup").hidden=true; $("start").hidden=true; count(); }
function removePeer(id) { const peer=peers.get(id); if (!peer) return; peer.pc.close(); peer.video?.remove(); peers.delete(id); count(); }
function peer(id) { const pc=new RTCPeerConnection(rtc), item={pc,video:null,candidates:[]}; peers.set(id,item); count(); stream?.getTracks().forEach(track=>pc.addTrack(track,stream)); pc.onicecandidate=({candidate})=>candidate&&socket?.emit("signal",{roomId,target:id,data:{candidate}}); pc.ontrack=({streams,track})=>{ if (!item.video) item.video=video(streams[0]||new MediaStream([track]),"Guest",false); }; pc.onconnectionstatechange=()=>["failed","closed"].includes(pc.connectionState)&&removePeer(id); return item; }
async function offer(id) { const item=peer(id); const offer=await item.pc.createOffer(); await item.pc.setLocalDescription(offer); socket.emit("signal",{roomId,target:id,data:{sdp:item.pc.localDescription}}); }
async function signal({from,data}) { const item=peers.get(from)||peer(from); if (data.sdp) { await item.pc.setRemoteDescription(data.sdp); await Promise.all(item.candidates.splice(0).map(candidate=>item.pc.addIceCandidate(candidate))); if (data.sdp.type==="offer") { const answer=await item.pc.createAnswer(); await item.pc.setLocalDescription(answer); socket.emit("signal",{roomId,target:from,data:{sdp:item.pc.localDescription}}); } } else if (data.candidate) { if (item.pc.remoteDescription) await item.pc.addIceCandidate(data.candidate); else item.candidates.push(data.candidate); } }
function setJoining(value) {
	joining = value;
	$("createRoom").disabled = value;
	$("joinRoom").disabled = value;
}

function failJoin(text) {
	setJoining(false);
	status(text);
	socket?.disconnect();
}

function connect() {
	socket?.disconnect();
	setJoining(true);
	status("Connecting to the room server...");
	socket = io({ forceNew: true, transports: ["polling", "websocket"] });
	socket.on("connect", () => {
		status("Joining room...");
		socket.timeout(10000).emit("join", { roomId, password, displayName: name() }, (error, result) => {
			if (error) return failJoin("The room server did not respond. Check the invite link and try again.");
			if (!result?.ok) return failJoin(`Could not join: ${result?.error || "unknown error"}`);
			setJoining(false);
			enter();
			status("Connected. Messages use this private room; calls are browser-to-browser.");
		});
	});
	socket.on("connect_error", () => failJoin("Could not reach the room server. Check your connection and try again."));
	socket.on("server-error", text => { if (joining) failJoin(`Could not join: ${text}`); else status(`Error: ${text}`); });
	socket.on("peer-joined", id => offer(id).catch(() => status("Could not connect to a guest.")));
	socket.on("peer-left", removePeer);
	socket.on("signal", data => signal(data).catch(() => status("Could not update the peer connection.")));
	socket.on("chat", data => message(data.name || "Guest", data.message, data.time));
	socket.on("file-shared", ({ fileId, name, size }) => { const row=document.createElement("div"), link=document.createElement("a"); row.className="message"; link.href=`/download/${encodeURIComponent(fileId)}`; link.textContent=`Download ${name} (${(size/1024).toFixed(1)} KB)`; row.append(link); $("messages").append(row); });
	socket.on("disconnect", reason => { if (!joining && reason !== "io client disconnect" && roomId) status("Disconnected from the room server."); });
}

async function create() { const requested=$("roomName").value.trim(), chosen=$("roomPassword").value; if (!chosen) return status("Choose a room password first."); roomId=requested?requested.replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,64):roomCode(); password=chosen; owner=true; setJoining(true); status("Creating room..."); try { const response=await fetch(`/create/${encodeURIComponent(roomId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})}), result=await response.json(); if (!response.ok) throw new Error(result.error||"Could not create room."); $("inviteUrl").value=roomUrl(); $("inviteDetails").hidden=false; connect(); } catch (error) { roomId=password=undefined; owner=false; setJoining(false); status(error.message); } }
function join() { roomId=$("joinRoomId").value.trim(); password=$("joinPassword").value; owner=false; if (!roomId||!password) return status("Enter both a room code and password."); connect(); }
async function camera() { if (stream) { stream.getTracks().forEach(track=>track.stop()); stream=undefined; localVideo?.remove(); localVideo=undefined; peers.forEach(({pc})=>pc.getSenders().forEach(sender=>sender.track&&pc.removeTrack(sender))); $("cameraBtn").textContent="Enable camera"; return; } try { stream=await navigator.mediaDevices.getUserMedia({video:true,audio:true}); localVideo=video(stream,"You",true); for (const [id,{pc}] of peers) { stream.getTracks().forEach(track=>pc.addTrack(track,stream)); const offer=await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit("signal",{roomId,target:id,data:{sdp:pc.localDescription}}); } $("cameraBtn").textContent="Disable camera"; } catch (error) { status(`Camera unavailable: ${error.message}`); } }
async function upload(file) { const data=new FormData(); data.append("file",file); status(`Sharing ${file.name}...`); try { const response=await fetch(`/upload/${encodeURIComponent(roomId)}`,{method:"POST",body:data}), result=await response.json(); if (!response.ok) throw new Error(result.error||"Upload failed."); status("File shared. It expires in 30 minutes."); } catch (error) { status(error.message); } }
function reset() { peers.forEach((_,id)=>removePeer(id)); socket?.disconnect(); socket=undefined; stream?.getTracks().forEach(track=>track.stop()); stream=undefined; localVideo?.remove(); localVideo=undefined; roomId=password=undefined; owner=false; setJoining(false); $("messages").replaceChildren(); $("videos").replaceChildren(); $("room").hidden=true; $("setup").hidden=true; $("start").hidden=false; $("confirm").hidden=true; $("cameraBtn").textContent="Enable camera"; }
async function copy(value) { try { await navigator.clipboard.writeText(value); status("Invite link copied. Share the password separately."); } catch { status("Copy failed. Select the link and copy it manually."); } }
$("showCreate").onclick=()=>show("create"); $("showJoin").onclick=()=>show("join"); $("createRoom").onclick=create; $("joinRoom").onclick=join; $("copyInvite").onclick=()=>copy($("inviteUrl").value); $("copyRoomInvite").onclick=()=>copy(roomUrl()); $("cameraBtn").onclick=camera; $("shareFile").onclick=()=>$("fileInput").click(); $("fileInput").onchange=({target})=>{if(target.files[0])upload(target.files[0]);target.value="";}; $("leaveRoom").onclick=()=>{confirmation=()=>{reset();status("You left the room.");}; $("confirmText").textContent="Leave this room?"; $("confirm").hidden=false;}; $("confirmYes").onclick=()=>confirmation?.(); $("confirmNo").onclick=()=>$("confirm").hidden=true; $("messageForm").onsubmit=(event)=>{event.preventDefault();const input=$("messageInput"),text=input.value.trim();if(!text||!socket?.connected)return;socket.emit("chat",{roomId,message:text},result=>!result?.ok&&status(result?.error||"Message was not sent."));input.value="";};
window.addEventListener("DOMContentLoaded",()=>{const shared=new URLSearchParams(location.search).get("room");if(shared){$("joinRoomId").value=shared;show("join");}});