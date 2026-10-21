const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { jwtSecret } = require('../config');
const { hashAppToken } = require('../utils/tokens');
const { canAccessChat } = require('../middleware/auth');
const { chatExists, getChat } = require('../utils/chatData');
const { subscribeToRoom, unsubscribeFromRoom } = require('./rooms');
const { joinVoiceRoom, leaveVoiceRoom, getVoiceRoom } = require('./voiceRooms');
const { createAndBroadcastMessage, editAndBroadcastMessage, deleteAndBroadcastMessage } = require('./messages');
const { getMessageWithCallerRole } = require('../utils/messagePermissions');

function attachWebSocketServer() {
  const wss = new WebSocket.Server({
    noServer: true,
    path: '/ws',
    handleProtocols: (protocols) => protocols.values().next().value,
    verifyClient: async (info, done) => {
      try {
        let url = new URL(info.req.url, 'http://localhost');
        let token = info.req.headers['sec-websocket-protocol'];
        if (token) {
          token = token.split(',')[0].trim();
        }
        if (!token) {
          const authHeader = info.req.headers.authorization;
          token = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;
        }
        if (!token) return done(false, 401, 'unauthorized');

        if (token.startsWith('hm.app.')) {
          const hash = hashAppToken(token);
          const r = await pool.query(
            `select u.id, u.username, bt.id as token_id
             from app_tokens bt join users u on u.id = bt.app_user_id
             where bt.token_hash = $1`,
            [hash]
          );
          const row = r.rows[0];
          if (!row) return done(false, 401, 'unauthorized');

          pool.query('update app_tokens set last_used_at = now() where id = $1', [row.token_id]).catch(() => {});
          info.req.user = { id: row.id, username: row.username, isApp: true };
        } else {
          info.req.user = jwt.verify(token, jwtSecret);
          info.req.user.isApp = false;
        }

        info.req.chatId = url.searchParams.get('chat_id');
        done(true);
      } catch (e) {
        done(false, 401, 'unauthorized');
      }
    }
  });

  wss.on('connection', async (ws, req) => {
    let userId = req.user.id;
    let username = req.user.username;
    let isSenderApp = req.user.isApp || false;
    if (req.chatId) {
      try {
        const exists = await chatExists(req.chatId);
        const allowed = exists && (await canAccessChat(req.chatId, userId));
        if (allowed && ws.readyState === WebSocket.OPEN) {
          subscribeToRoom(ws, req.chatId);
        }
      } catch (err) {
        console.error('failed to validate websocket chat', err);
      }
    }

    ws.on('message', async (raw) => {
      const rawStr = raw.toString().trim();
      if (!rawStr) {
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(rawStr);
      } catch (e) {
      }

      if (parsed && typeof parsed === 'object') {
        if (parsed.action === 'join_room') {
          if (!parsed.chat_id) {
            return ws.send(JSON.stringify({ error: 'chat_id is required for join_room' }));
          }
          if (!(await chatExists(parsed.chat_id))) {
            return ws.send(JSON.stringify({ error: 'chat not found' }));
          }
          if (!(await canAccessChat(parsed.chat_id, userId))) {
            return ws.send(JSON.stringify({ error: 'you do not have access to this chat' }));
          }
          subscribeToRoom(ws, parsed.chat_id, { active: parsed.active !== false });
          return ws.send(JSON.stringify({ event: 'joined_room', chat_id: parsed.chat_id }));
        }

        if (parsed.action === 'leave_room') {
          const prevChatId = parsed.chat_id || ws.chatId;
          unsubscribeFromRoom(ws, prevChatId);
          return ws.send(JSON.stringify({ event: 'left_room', chat_id: prevChatId }));
        }

        if (parsed.action === 'join_voice') {
          if (!parsed.chat_id) {
            return ws.send(JSON.stringify({ error: 'chat_id is required for join_voice' }));
          }
          const chat = await getChat(parsed.chat_id);
          if (!chat || chat.type !== 'voice') {
            return ws.send(JSON.stringify({ error: 'not a voice channel' }));
          }
          if (!(await canAccessChat(parsed.chat_id, userId))) {
            return ws.send(JSON.stringify({ error: 'you do not have access to this channel' }));
          }
          if (ws.voiceChatId && ws.voiceChatId !== parsed.chat_id) {
            leaveVoiceRoom(ws);
          }
          const existingPeers = joinVoiceRoom(ws, parsed.chat_id, userId, username);
          return ws.send(JSON.stringify({ event: 'joined_voice', chat_id: parsed.chat_id, peers: existingPeers }));
        }

        if (parsed.action === 'leave_voice') {
          const prevVoiceChatId = ws.voiceChatId;
          leaveVoiceRoom(ws);
          return ws.send(JSON.stringify({ event: 'left_voice', chat_id: prevVoiceChatId }));
        }

        if (parsed.action === 'edit_message') {
          const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
          if (!parsed.message_id || !content || content.length > 4000) {
            return ws.send(JSON.stringify({ error: 'message_id and content (1-4000 chars) are required for edit_message' }));
          }
          try {
            const message = await getMessageWithCallerRole(parsed.message_id, userId);
            if (!message || message.deleted_at) {
              return ws.send(JSON.stringify({ error: 'message not found' }));
            }
            if (message.sender_id !== userId) {
              return ws.send(JSON.stringify({ error: 'you can only edit your own messages' }));
            }
            await editAndBroadcastMessage({ messageId: parsed.message_id, chatId: message.chat_id, content });
          } catch (e) {
            console.error('failed to edit message over ws', e);
            ws.send(JSON.stringify({ error: 'failed to edit message' }));
          }
          return;
        }

        if (parsed.action === 'delete_message') {
          if (!parsed.message_id) {
            return ws.send(JSON.stringify({ error: 'message_id is required for delete_message' }));
          }
          try {
            const message = await getMessageWithCallerRole(parsed.message_id, userId);
            if (!message || message.deleted_at) {
              return ws.send(JSON.stringify({ error: 'message not found' }));
            }
            const isOwnMessage = message.sender_id === userId;
            const canModerate = !!message.can_delete_any_message;
            if (!isOwnMessage && !canModerate) {
              return ws.send(JSON.stringify({ error: 'you do not have permission to delete this message' }));
            }
            await deleteAndBroadcastMessage({ messageId: parsed.message_id, chatId: message.chat_id });
          } catch (e) {
            console.error('failed to delete message over ws', e);
            ws.send(JSON.stringify({ error: 'failed to delete message' }));
          }
          return;
        }

        if (parsed.action === 'voice_signal') {
          if (!ws.voiceChatId || !parsed.to || !parsed.signal) {
            return ws.send(JSON.stringify({ error: 'invalid voice_signal payload' }));
          }
          const room = getVoiceRoom(ws.voiceChatId);
          const target = room?.get(parsed.to);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify({
              event: 'voice_signal',
              chat_id: ws.voiceChatId,
              from: userId,
              signal: parsed.signal
            }));
          }
          return;
        }
      }

      const content = parsed && typeof parsed.content === 'string' ? parsed.content.trim() : rawStr;
      const replyToId = parsed && typeof parsed.reply_to_id === 'string' ? parsed.reply_to_id : null;

      if (!content || content.length > 4000) {
        return ws.send(JSON.stringify({ error: 'message must be 1 to 4000 characters' }));
      }

      if (!ws.chatId) {
        return ws.send(JSON.stringify({ error: 'no active chat room selected' }));
      }

      try {
        await createAndBroadcastMessage({
          chatId: ws.chatId,
          senderId: userId,
          senderUsername: username,
          isSenderApp: isSenderApp,
          content: content,
          replyToId: replyToId
        });
      } catch (e) {
        if (e.code === 'INVALID_REPLY_TO') {
          return ws.send(JSON.stringify({ error: e.message }));
        }
        console.error('failed to save message', e);
        ws.send(JSON.stringify({ error: 'failed to send message' }));
      }
    });

    ws.on('close', () => {
      unsubscribeFromRoom(ws);
      leaveVoiceRoom(ws);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for user ${username}:`, err.message);
      unsubscribeFromRoom(ws);
      leaveVoiceRoom(ws);
    });
  });

  return wss;
}

const { attachLiveKitProxy } = require('./voiceProxy');

function attachAllWebSockets(server) {
  const mainWss = attachWebSocketServer();
  const liveKitRoutes = attachLiveKitProxy();
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];

    const route =
      pathname === '/ws' ? { wss: mainWss } :
      liveKitRoutes.find((r) => r.path === pathname);

    if (!route) {
      socket.destroy();
      return;
    }

    route.wss.handleUpgrade(req, socket, head, (ws) => {
      route.wss.emit('connection', ws, req);
    });
  });
}

module.exports = { attachWebSocketServer, attachLiveKitProxy, attachAllWebSockets };