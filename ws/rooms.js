const WebSocket = require('ws');

const rooms = new Map();

function subscribeToRoom(ws, chatId, options = {}) {
  if (!chatId) return;

  if (!ws.chatIds) {
    ws.chatIds = new Set();
  }

  if (options.active !== false) {
    ws.chatId = chatId;
  }
  if (!rooms.has(chatId)) {
    rooms.set(chatId, new Set());
  }
  rooms.get(chatId).add(ws);
  ws.chatIds.add(chatId);
}

function unsubscribeFromRoom(ws, chatId = null) {
  if (!ws.chatIds) {
    ws.chatIds = new Set();
  }

  const chatIds = chatId ? [chatId] : [...ws.chatIds];
  for (const subscribedChatId of chatIds) {
    const room = rooms.get(subscribedChatId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        rooms.delete(subscribedChatId);
      }
    }
    ws.chatIds.delete(subscribedChatId);
  }

  if (!chatId || ws.chatId === chatId) {
    ws.chatId = null;
  }
}

function broadcastToRoom(chatId, payload) {
  const subscribers = rooms.get(chatId);
  if (!subscribers) return;
  const raw = JSON.stringify(payload);
  for (const c of subscribers) {
    if (c.readyState === WebSocket.OPEN) {
      c.send(raw);
    }
  }
}

module.exports = { subscribeToRoom, unsubscribeFromRoom, broadcastToRoom };
