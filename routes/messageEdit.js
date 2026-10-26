const express = require('express');
const { pool } = require('../db');
const { authenticateToken, blockApps, canAccessChat } = require('../middleware/auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LENGTH = 4000;

const router = express.Router();

router.patch('/messages/:messageId', authenticateToken, blockApps, async (req, res) => {
  const { messageId } = req.params;
  if (!UUID_RE.test(messageId)) {
    return res.status(400).json({ error: 'invalid message id' });
  }

  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > MAX_LENGTH) {
    return res.status(400).json({ error: `message must be 1 to ${MAX_LENGTH} characters` });
  }

  try {
    const existing = await pool.query(
      'select id, chat_id, sender_id, webhook_id from messages where id = $1 and deleted_at is null',
      [messageId]
    );
    const message = existing.rows[0];
    if (!message || !(await canAccessChat(message.chat_id, req.user.id))) {
      return res.status(404).json({ error: 'message not found' });
    }
    if (message.sender_id !== req.user.id || message.webhook_id) {
      return res.status(403).json({ error: 'you can only edit your own messages' });
    }

    const r = await pool.query(
      `update messages set content = $1, edited_at = now()
        where id = $2
        returning id, content, edited_at`,
      [content, messageId]
    );

    // todo: message edited event

    res.json(r.rows[0]);
  } catch (e) {
    console.error('failed to edit message', e);
    res.status(500).json({ error: 'failed to edit message' });
  }
});

module.exports = { router };