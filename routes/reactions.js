const express = require('express');
const { pool } = require('../db');
const {
  authenticateToken,
  blockApps,
  requireVerifiedEmail,
  requireNotLimited,
  canAccessChat
} = require('../middleware/auth');
const { reactAndBroadcast } = require('../ws/messages');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EMOJI = 20;  // per message
const MAX_REACTIONS_PER_MINUTE = 30; // per user

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// just one emoji
function isSingleEmoji(value) {
  if (typeof value !== 'string' || !value || value.length > 32) return false;
  if ([...segmenter.segment(value)].length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|^[0-9#*]\uFE0F?\u20E3$/u.test(value);
}

async function loadReactableMessage(req, res) {
  const { messageId, emoji } = req.params;
  if (!UUID_RE.test(messageId)) {
    res.status(400).json({ error: 'invalid message id' });
    return null;
  }
  if (!isSingleEmoji(emoji)) {
    res.status(400).json({ error: 'reactions must be a single emoji' });
    return null;
  }
  const r = await pool.query('select id, chat_id from messages where id = $1 and deleted_at is null', [messageId]);
  const message = r.rows[0];
  if (!message || !(await canAccessChat(message.chat_id, req.user.id))) {
    res.status(404).json({ error: 'message not found' });
    return null;
  }
  return { message, emoji };
}

const router = express.Router();

router.put(
  '/messages/:messageId/reactions/:emoji',
  authenticateToken,
  blockApps,
  requireNotLimited,
  requireVerifiedEmail('react to messages'),
  async (req, res) => {
    try {
      const found = await loadReactableMessage(req, res);
      if (!found) return;
      const { message, emoji } = found;

      const recent = await pool.query(
        "select count(*)::int as n from message_reactions where user_id = $1 and created_at > now() - interval '1 minute'",
        [req.user.id]
      );
      if (recent.rows[0].n >= MAX_REACTIONS_PER_MINUTE) {
        return res.status(429).json({ error: 'you are reacting too quickly' });
      }

      const existing = await pool.query(
        'select emoji from message_reactions where message_id = $1 group by emoji',
        [message.id]
      );
      const known = existing.rows.some((row) => row.emoji === emoji);
      if (!known && existing.rowCount >= MAX_EMOJI) {
        return res.status(400).json({ error: 'this message has too many different reactions' });
      }

      const payload = await reactAndBroadcast({
        messageId: message.id,
        chatId: message.chat_id,
        userId: req.user.id,
        emoji,
        add: true
      });
      res.json(payload);
    } catch (e) {
      console.error('failed to add reaction', e);
      res.status(500).json({ error: 'failed to add reaction' });
    }
  }
);

router.delete(
  '/messages/:messageId/reactions/:emoji',
  authenticateToken,
  blockApps,
  async (req, res) => {
    try {
      const found = await loadReactableMessage(req, res);
      if (!found) return;
      const { message, emoji } = found;

      const payload = await reactAndBroadcast({
        messageId: message.id,
        chatId: message.chat_id,
        userId: req.user.id,
        emoji,
        add: false
      });
      res.json(payload);
    } catch (e) {
      console.error('failed to remove reaction', e);
      res.status(500).json({ error: 'failed to remove reaction' });
    }
  }
);

module.exports = { router };