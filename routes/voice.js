const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const { authenticateToken, canAccessChat, requireVerifiedEmail } = require('../middleware/auth');
const { pool } = require('../db');

const router = express.Router();

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

router.post('/token', authenticateToken, requireVerifiedEmail('join voice channels'), async (req, res) => {
  const { chat_id } = req.body;
  const userId = req.user.id;

  if (!chat_id) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    if (!(await canAccessChat(chat_id, userId))) {
      return res.status(403).json({ error: 'No access to this chat' });
    }

    const userResult = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: user.id,
      name: user.username
    });
    at.addGrant({
      roomJoin: true,
      room: `chat:${chat_id}`,
      canPublish: true,
      canSubscribe: true
    });

    const token = await at.toJwt();
    res.json({ token });
  } catch (err) {
    console.error('Error generating voice token:', err);
    res.status(500).json({ error: 'Could not generate token' });
  }
});

module.exports = router;
