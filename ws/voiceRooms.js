const WebSocket = require('ws');

const voiceRooms = new Map();

function joinVoiceRoom(ws, chatId, userId, username) {
  if (!voiceRooms.has(chatId)) {
    voiceRooms.set(chatId, new Map());
  }
  const room = voiceRooms.get(chatId);
  const existingPeers = Array.from(room.entries())
    .filter(([id]) => id !== userId)
    .map(([id, peer]) => ({ id, username: peer.username }));

  room.set(userId, { ws, username });
  ws.voiceChatId = chatId;

  for (const [, peer] of room) {
    if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify({ event: 'voice_peer_joined', chat_id: chatId, id: userId, username }));
    }
  }

  return existingPeers;
}

function leaveVoiceRoom(ws) {
  const chatId = ws.voiceChatId;
  if (!chatId) return;

  const room = voiceRooms.get(chatId);
  if (room) {
    let leavingUserId = null;
    for (const [id, peer] of room) {
      if (peer.ws === ws) {
        leavingUserId = id;
        break;
      }
    }
    if (leavingUserId !== null) {
      room.delete(leavingUserId);
      for (const [, peer] of room) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify({ event: 'voice_peer_left', chat_id: chatId, id: leavingUserId }));
        }
      }
    }
    if (room.size === 0) {
      voiceRooms.delete(chatId);
    }
  }
  ws.voiceChatId = null;
}

function getVoiceRoom(chatId) {
  return voiceRooms.get(chatId);
}

module.exports = { joinVoiceRoom, leaveVoiceRoom, getVoiceRoom };
