const express = require('express');
const { pool } = require('../db');
const { authenticateToken, blockApps, getSpaceMembership } = require('../middleware/auth');
const { hashAppToken, generateWebhookToken } = require('../utils/tokens');
const { createAndBroadcastMessage } = require('../ws/messages');

const router = express.Router();

async function getOwnedApp(appId, ownerId) {
  const result = await pool.query(
    'select id, username from users where id = $1 and is_bot = true and app_owner_id = $2',
    [appId, ownerId]
  );
  return result.rows[0] || null;
}

async function getTextChat(chatId) {
  const result = await pool.query(
    `select c.id, c.type, c.space_id
     from chats c
     where c.id = $1`,
    [chatId]
  );
  const chat = result.rows[0];
  return chat && chat.type === 'text' ? chat : null;
}

router.post('/apps/:appId/webhooks', authenticateToken, blockApps, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const chatId = typeof req.body?.chat_id === 'string' ? req.body.chat_id : '';
  if (!name || name.length > 80 || !chatId) {
    return res.status(400).json({ error: 'name and chat_id are required; name must be 1 to 80 characters' });
  }

  try {
    const app = await getOwnedApp(req.params.appId, req.user.id);
    if (!app) return res.status(404).json({ error: 'app not found' });

    const chat = await getTextChat(chatId);
    if (!chat) return res.status(404).json({ error: 'text chat not found' });

    const role = await getSpaceMembership(chat.space_id, req.user.id);
    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'you must be an owner or admin of that space' });
    }

    const token = generateWebhookToken();
    const result = await pool.query(
      `insert into webhooks (app_user_id, chat_id, name, token_hash)
       values ($1, $2, $3, $4)
       returning id, app_user_id, chat_id, name, created_at`,
      [app.id, chat.id, name, hashAppToken(token)]
    );
    res.status(201).json({ webhook: result.rows[0], token });
  } catch (error) {
    console.error('failed to create webhook', error);
    res.status(500).json({ error: 'failed to create webhook' });
  }
});

router.get('/apps/:appId/webhooks', authenticateToken, blockApps, async (req, res) => {
  try {
    const app = await getOwnedApp(req.params.appId, req.user.id);
    if (!app) return res.status(404).json({ error: 'app not found' });

    const result = await pool.query(
      `select w.id, w.app_user_id, w.chat_id, w.name, w.last_used_at, w.created_at,
              c.name as chat_name
       from webhooks w
       join chats c on c.id = w.chat_id
       where w.app_user_id = $1
       order by w.created_at desc`,
      [app.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('failed to list webhooks', error);
    res.status(500).json({ error: 'failed to list webhooks' });
  }
});

router.delete('/apps/:appId/webhooks/:webhookId', authenticateToken, blockApps, async (req, res) => {
  try {
    const app = await getOwnedApp(req.params.appId, req.user.id);
    if (!app) return res.status(404).json({ error: 'app not found' });

    const result = await pool.query(
      'delete from webhooks where id = $1 and app_user_id = $2 returning id',
      [req.params.webhookId, app.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'webhook not found' });
    res.json({ message: 'webhook deleted' });
  } catch (error) {
    console.error('failed to delete webhook', error);
    res.status(500).json({ error: 'failed to delete webhook' });
  }
});

router.post('/webhooks/:token', async (req, res) => {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'content must be 1 to 4000 characters' });
  }

  try {
    const result = await pool.query(
      `select w.id as webhook_id, w.chat_id, u.id as app_user_id, u.username
       from webhooks w
       join users u on u.id = w.app_user_id
       where w.token_hash = $1`,
      [hashAppToken(token)]
    );
    const webhook = result.rows[0];
    if (!webhook) return res.status(401).json({ error: 'invalid webhook token' });

    const payload = await createAndBroadcastMessage({
      chatId: webhook.chat_id,
      senderId: webhook.app_user_id,
      senderUsername: webhook.username,
      isSenderApp: true,
      content,
      replyToId: null
    });
    pool.query('update webhooks set last_used_at = now() where id = $1', [webhook.webhook_id]).catch(() => {});
    res.status(201).json(payload);
  } catch (error) {
    console.error('failed to deliver webhook', error);
    res.status(500).json({ error: 'failed to deliver webhook' });
  }
});

module.exports = router;
