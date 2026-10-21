const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { authenticateToken, requireSpaceAccess, canAccessChat } = require('../middleware/auth');
const { chatExists } = require('../utils/chatData');
const { createAndBroadcastMessage, editAndBroadcastMessage, deleteAndBroadcastMessage } = require('../ws/messages');
const { getMessageWithCallerRole } = require('../utils/messagePermissions');
const { buildMessagesPageQuery, UUID_RE, MESSAGES_PAGE_SIZE } = require('../utils/messagePagination');

const router = express.Router();
const attachmentsDir = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', 'uploads');
const MAX_ATTACHMENT_BYTES = 20_000_000;
fs.mkdirSync(attachmentsDir, { recursive: true });

function decodeFileName(value) {
  if (typeof value !== 'string' || !value) return 'attachment';
  try {
    return decodeURIComponent(value).replace(/[\\/\0]/g, '').trim().slice(0, 255) || 'attachment';
  } catch {
    return 'attachment';
  }
}

function attachmentPayload(row) {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    url: `/api/attachments/${row.id}`
  };
}

// one query grabs every attachment instead of one query per message
async function attachmentsByMessageId(messageIds) {
  if (messageIds.length === 0) return new Map();
  const r = await pool.query(
    `select message_id, id, original_name, mime_type, size_bytes
     from attachments where message_id = any($1::uuid[]) order by created_at asc`,
    [messageIds]
  );
  const byMessage = new Map();
  for (const row of r.rows) {
    const list = byMessage.get(row.message_id) || [];
    list.push(attachmentPayload(row));
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

const getChatsHandler = async (req, res) => {
  const { spaceId } = req.params;
  try {
    const r = await pool.query(
      'select id, space_id, name, type, created_at from chats where space_id = $1 order by created_at asc',
      [spaceId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to fetch chats', e);
    res.status(500).json({ error: 'failed to fetch chats' });
  }
};

const createChatHandler = async (req, res) => {
  const { spaceId } = req.params;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const type = req.body?.type;

  if (!name || name.length > 80 || !['text', 'voice'].includes(type)) {
    return res.status(400).json({ error: 'name must be 1 to 80 characters and type must be text or voice' });
  }

  try {
    const r = await pool.query(
      'insert into chats (space_id, name, type) select id, $2, $3 from spaces where id = $1 returning id, space_id, name, type, created_at',
      [spaceId, name, type]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'space not found' });
    }
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('failed to create chat', e);
    res.status(500).json({ error: 'failed to create chat' });
  }
};

const getMessagesHandler = async (req, res) => {
  const { chat_id } = req.query;
  const beforeAt = typeof req.query.before_at === 'string' ? req.query.before_at : null;
  const beforeId = typeof req.query.before_id === 'string' ? req.query.before_id : null;

  if (!chat_id) {
    return res.status(400).json({ error: 'chat_id query parameter is required' });
  }
  if (!!beforeAt !== !!beforeId) {
    return res.status(400).json({ error: 'before_at and before_id must be provided together' });
  }
  if (beforeAt && (Number.isNaN(Date.parse(beforeAt)) || !UUID_RE.test(beforeId))) {
    return res.status(400).json({ error: 'before_at must be a timestamp and before_id must be a message id' });
  }

  try {
    if (!(await chatExists(chat_id))) {
      return res.status(404).json({ error: 'chat not found' });
    }

    if (!(await canAccessChat(chat_id, req.user.id))) {
      return res.status(403).json({ error: 'you do not have access to this chat' });
    }

    const page = buildMessagesPageQuery(chat_id, beforeAt, beforeId);
    const r = await pool.query(page.text, page.params);
    const hasMore = r.rows.length > MESSAGES_PAGE_SIZE;
    const rows = hasMore ? r.rows.slice(0, MESSAGES_PAGE_SIZE) : r.rows;
    const attachments = await attachmentsByMessageId(rows.map((row) => row.id));
    const messages = rows.map((row) => ({
      ...row,
      attachments: attachments.get(row.id) || []
    }));
    res.json({ messages, hasMore });
  } catch (e) {
    console.error('failed to fetch messages', e);
    res.status(500).json({ error: 'failed to fetch messages' });
  }
};

router.get('/spaces/:spaceId/chats', authenticateToken, requireSpaceAccess(), getChatsHandler);
router.post('/spaces/:spaceId/chats', authenticateToken, requireSpaceAccess(['owner', 'admin']), createChatHandler);

router.get('/messages', authenticateToken, getMessagesHandler);

router.post(
  '/chats/:chatId/attachments',
  authenticateToken,
  express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES }),
  async (req, res) => {
    const { chatId } = req.params;
    const file = Buffer.isBuffer(req.body) ? req.body : null;
    if (!file || file.length === 0) {
      return res.status(400).json({ error: 'attachment body is required' });
    }

    try {
      if (!(await chatExists(chatId))) return res.status(404).json({ error: 'chat not found' });
      if (!(await canAccessChat(chatId, req.user.id))) {
        return res.status(403).json({ error: 'you do not have access to this chat' });
      }

      if (file.length > MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: 'attachments are limited to 20 MB' });
      }

      const originalName = decodeFileName(req.headers['x-file-name']);
      const mimeType = typeof req.headers['x-file-type'] === 'string'
        ? req.headers['x-file-type'].slice(0, 120)
        : 'application/octet-stream';
      // svgs open up room for xss attach which is why we don't allow them
      if (/svg/i.test(mimeType) || /\.svg$/i.test(originalName)) {
        return res.status(415).json({ error: 'SVG attachments are not supported' });
      }
      const extension = path.extname(originalName).toLowerCase().slice(0, 12);
      const storageKey = `${crypto.randomUUID()}${extension}`;
      const filePath = path.join(attachmentsDir, storageKey);
      fs.writeFileSync(filePath, file, { flag: 'wx' });

      try {
        const payload = await createAndBroadcastMessage({
          chatId,
          senderId: req.user.id,
          senderUsername: req.user.username,
          isSenderApp: req.user.isApp || false,
          content: '',
          attachments: [{
            uploaderId: req.user.id,
            originalName,
            mimeType,
            sizeBytes: file.length,
            storageKey
          }]
        });
        res.status(201).json(payload);
      } catch (error) {
        fs.rmSync(filePath, { force: true });
        throw error;
      }
    } catch (e) {
      console.error('failed to upload attachment', e);
      res.status(500).json({ error: 'failed to upload attachment' });
    }
  }
);

function attachmentContentDisposition(originalName, forceDownload = false) {
  const cleaned = String(originalName || 'file').replace(/[\r\n"\\]/g, '').trim() || 'file';
  const asciiName = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/;/g, '_') || 'file';
  const encodedName = encodeURIComponent(cleaned);
  return `${forceDownload ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

router.get('/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `select a.storage_key, a.original_name, a.mime_type, m.chat_id
       from attachments a
       join messages m on m.id = a.message_id
       where a.id = $1 and m.deleted_at is null`,
      [req.params.attachmentId]
    );
    const attachment = result.rows[0];
    if (!attachment || !(await canAccessChat(attachment.chat_id, req.user.id))) {
      return res.status(404).json({ error: 'attachment not found' });
    }
    res.type(attachment.mime_type);
    res.set('X-Content-Type-Options', 'nosniff');
    const isImage = /^image\//i.test(attachment.mime_type);
    if (isImage) {
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.set('Content-Disposition', attachmentContentDisposition(attachment.original_name, true));
    } else {
      res.set('Content-Disposition', attachmentContentDisposition(attachment.original_name));
    }
    res.sendFile(attachment.storage_key, { root: attachmentsDir });
  } catch (e) {
    console.error('failed to download attachment', e);
    res.status(404).json({ error: 'attachment not found' });
  }
});

router.post('/messages', authenticateToken, async (req, res) => {
  const chatId = typeof req.body?.chat_id === 'string' ? req.body.chat_id : null;
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const replyToId = typeof req.body?.reply_to_id === 'string' ? req.body.reply_to_id : null;

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'message must be 1 to 4000 characters' });
  }

  try {
    if (!(await chatExists(chatId))) {
      return res.status(404).json({ error: 'chat not found' });
    }
    if (!(await canAccessChat(chatId, req.user.id))) {
      return res.status(403).json({ error: 'you do not have access to this chat' });
    }

    const payload = await createAndBroadcastMessage({
      chatId: chatId,
      senderId: req.user.id,
      senderUsername: req.user.username,
      isSenderApp: req.user.isApp || false,
      content: content,
      replyToId: replyToId
    });

    res.status(201).json(payload);
  } catch (e) {
    if (e.code === 'INVALID_REPLY_TO') {
      return res.status(400).json({ error: e.message });
    }
    console.error('failed to send message', e);
    res.status(500).json({ error: 'failed to send message' });
  }
});

router.patch('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'message must be 1 to 4000 characters' });
  }

  try {
    const message = await getMessageWithCallerRole(messageId, req.user.id);
    if (!message || message.deleted_at) {
      return res.status(404).json({ error: 'message not found' });
    }
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'you can only edit your own messages' });
    }

    const payload = await editAndBroadcastMessage({
      messageId,
      chatId: message.chat_id,
      content
    });

    res.json(payload);
  } catch (e) {
    if (e.code === 'MESSAGE_NOT_FOUND') {
      return res.status(404).json({ error: 'message not found' });
    }
    console.error('failed to edit message', e);
    res.status(500).json({ error: 'failed to edit message' });
  }
});

router.delete('/messages/:messageId', authenticateToken, async (req, res) => {
  const { messageId } = req.params;

  try {
    const message = await getMessageWithCallerRole(messageId, req.user.id);
    if (!message || message.deleted_at) {
      return res.status(404).json({ error: 'message not found' });
    }

    const isOwnMessage = message.sender_id === req.user.id;
    const canModerate = !!message.can_delete_any_message;
    if (!isOwnMessage && !canModerate) {
      return res.status(403).json({ error: 'you do not have permission to delete this message' });
    }

    const payload = await deleteAndBroadcastMessage({
      messageId,
      chatId: message.chat_id
    });

    res.json(payload);
  } catch (e) {
    if (e.code === 'MESSAGE_NOT_FOUND') {
      return res.status(404).json({ error: 'message not found' });
    }
    console.error('failed to delete message', e);
    res.status(500).json({ error: 'failed to delete message' });
  }
});

module.exports = { router, getMessagesHandler, buildMessagesPageQuery };
