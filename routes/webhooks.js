const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { authenticateToken, blockApps, getSpaceMembership } = require('../middleware/auth');
const { hashAppToken, generateWebhookToken } = require('../utils/tokens');
const {
  createAndBroadcastMessage,
  editAndBroadcastMessage,
  deleteAndBroadcastMessage
} = require('../ws/messages');

const router = express.Router();
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 2000;
const WEBHOOK_RATE_LIMIT_MAX = 5;
const WEBHOOK_MESSAGE_LIMIT = 4000;
const webhookRequestTimes = new Map();
const attachmentsDir = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', 'uploads');

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

async function deliverWebhookMessage(webhook, content, deliveryId, attachment = null, overrides = {}) {
  const delivery = await pool.query(
    `insert into webhook_deliveries (webhook_id, delivery_id)
     values ($1, $2)
     on conflict do nothing
     returning delivery_id`,
    [webhook.webhook_id, deliveryId]
  );
  if (delivery.rowCount === 0) return null;

  let attachmentPath = null;
  try {
    const attachments = [];
    if (attachment) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
      const storageKey = `${crypto.randomUUID()}.json`;
      attachmentPath = path.join(attachmentsDir, storageKey);
      fs.writeFileSync(attachmentPath, attachment, { flag: 'wx' });
      attachments.push({
        uploaderId: webhook.app_user_id,
        originalName: 'truncuated.json',
        mimeType: 'application/json',
        sizeBytes: attachment.length,
        storageKey
      });
    }

    const payload = await createAndBroadcastMessage({
      chatId: webhook.chat_id,
      senderId: webhook.app_user_id,
      senderUsername: webhook.username,
      senderDisplayName: overrides.displayName || webhook.name,
      senderNameOverride: overrides.displayName || webhook.name,
      senderAvatarUrl: overrides.avatarUrl,
      isSenderApp: true,
      content: content.length > 4000 ? `${content.slice(0, 3997)}...` : content,
      replyToId: null,
      webhookId: webhook.webhook_id,
      attachments
    });
    pool.query('update webhooks set last_used_at = now() where id = $1', [webhook.webhook_id]).catch(() => {});
    pool.query("delete from webhook_deliveries where processed_at < now() - interval '7 days'").catch(() => {});
    return payload;
  } catch (error) {
    if (attachmentPath) fs.rmSync(attachmentPath, { force: true });
    await pool.query(
      'delete from webhook_deliveries where webhook_id = $1 and delivery_id = $2',
      [webhook.webhook_id, deliveryId]
    ).catch(() => {});
    throw error;
  }
}

function getMessageOverrides(body) {
  if (typeof body === 'string') return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'request body must be a JSON object' };
  const rawName = body.display_name ?? body.username;
  let displayName;
  if (rawName !== undefined) {
    if (typeof rawName !== 'string' || !rawName.trim() || rawName.trim().length > 80) {
      return { error: 'display_name must be 1 to 80 characters' };
    }
    displayName = rawName.trim();
  }

  let avatarUrl;
  if (body.avatar_url !== undefined) {
    if (typeof body.avatar_url !== 'string' || body.avatar_url.length > 2048) {
      return { error: 'avatar_url must be a valid HTTP or HTTPS URL' };
    }
    try {
      const parsed = new URL(body.avatar_url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return { error: 'avatar_url must be a valid HTTP or HTTPS URL' };
      }
      avatarUrl = parsed.href;
    } catch {
      return { error: 'avatar_url must be a valid HTTP or HTTPS URL' };
    }
  }
  return { displayName, avatarUrl };
}

function executePayloadContent(body) {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const parts = [];
  if (typeof body.content === 'string' && body.content.trim()) parts.push(body.content.trim());

  if (Array.isArray(body.embeds)) {
    for (const embed of body.embeds.slice(0, 10)) {
      if (!embed || typeof embed !== 'object') continue;
      const lines = [];
      if (typeof embed.title === 'string' && embed.title.trim()) lines.push(`**${embed.title.trim()}**`);
      if (typeof embed.description === 'string' && embed.description.trim()) lines.push(embed.description.trim());
      if (Array.isArray(embed.fields)) {
        for (const field of embed.fields.slice(0, 25)) {
          if (typeof field?.value !== 'string' || !field.value.trim()) continue;
          lines.push(field.name ? `**${field.name}**\n${field.value.trim()}` : field.value.trim());
        }
      }
      if (typeof embed.url === 'string' && /^https?:\/\//i.test(embed.url)) lines.push(embed.url);
      if (embed.image?.url && /^https?:\/\//i.test(embed.image.url)) lines.push(embed.image.url);
      if (embed.thumbnail?.url && /^https?:\/\//i.test(embed.thumbnail.url)) lines.push(embed.thumbnail.url);
      if (embed.footer?.text) lines.push(`_${embed.footer.text}_`);
      if (lines.length) parts.push(lines.join('\n'));
    }
  }

  if (parts.length) return parts.join('\n\n');

  const prettyJson = JSON.stringify(body, null, 2);
  if (/^```[\s\S]*```$/.test(prettyJson.trim())) return prettyJson.trim();
  const compactJson = JSON.stringify(body);
  const json = prettyJson.length < WEBHOOK_MESSAGE_LIMIT - 16 ? prettyJson : compactJson;
  const openingFence = '```\n';
  const closingFence = '\n```';
  const available = WEBHOOK_MESSAGE_LIMIT - openingFence.length - closingFence.length;
  if (json.length <= available) return `${openingFence}${json}${closingFence}`;

  const marker = '\n... [JSON truncated]';
  const visibleLength = available - marker.length;
  return `${openingFence}${json.slice(0, visibleLength)}${marker}${closingFence}`;
}

function getLargeJsonAttachment(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const hasMessageContent = typeof body.content === 'string' && body.content.trim();
  const hasEmbeds = Array.isArray(body.embeds) && body.embeds.length > 0;
  if (hasMessageContent || hasEmbeds) return null;

  const json = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
  return json.length > WEBHOOK_MESSAGE_LIMIT ? json : null;
}

function limitWebhookContent(content) {
  if (content.length <= WEBHOOK_MESSAGE_LIMIT) return content;
  const fenced = content.match(/^(```[^\n]*\n)([\s\S]*)(\n```\s*)$/);
  if (fenced) {
    const marker = '\n... [message truncated]';
    const visibleLength = WEBHOOK_MESSAGE_LIMIT - fenced[1].length - fenced[3].length - marker.length;
    return `${fenced[1]}${fenced[2].slice(0, visibleLength)}${marker}${fenced[3]}`;
  }
  return `${content.slice(0, WEBHOOK_MESSAGE_LIMIT - 3)}...`;
}

function applyWebhookRateLimit(req, res, webhookId) {
  const now = Date.now();
  const recent = (webhookRequestTimes.get(webhookId) || []).filter((time) => now - time < WEBHOOK_RATE_LIMIT_WINDOW_MS);
  if (recent.length >= WEBHOOK_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(0.1, (WEBHOOK_RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000);
    res.set('X-RateLimit-Limit', String(WEBHOOK_RATE_LIMIT_MAX));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset-After', retryAfter.toFixed(3));
    res.set('Retry-After', retryAfter.toFixed(3));
    return false;
  }
  recent.push(now);
  webhookRequestTimes.set(webhookId, recent);
  res.set('X-RateLimit-Limit', String(WEBHOOK_RATE_LIMIT_MAX));
  res.set('X-RateLimit-Remaining', String(WEBHOOK_RATE_LIMIT_MAX - recent.length));
  res.set('X-RateLimit-Reset-After', '2.000');
  return true;
}

function parseWebhookBody(req) {
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.isBuffer(req.body)
      ? req.body
      : null;
  if (!rawBody) return req.body;

  const text = rawBody.toString('utf8');
  if (!text.trim()) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

function captureWebhookBody(req, res, next) {
  const parser = express.raw({
    type: () => true,
    limit: '1mb',
    verify(request, response, buffer) {
      request.rawBody = Buffer.from(buffer);
    }
  });

  parser(req, res, (error) => {
    if (error) return next(error);
    if (!Buffer.isBuffer(req.rawBody) && Buffer.isBuffer(req.body)) {
      req.rawBody = Buffer.from(req.body);
    }
    req.webhookPayload = parseWebhookBody(req);
    next();
  });
}

async function receiveWebhook(req, res) {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  const webhookId = req.params.webhookId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(webhookId || '')) {
    return res.status(404).json({ error: 'webhook not found' });
  }
  const deliveryId = crypto.randomUUID();

  try {
    const result = await pool.query(
      `select w.id as webhook_id, w.name, w.chat_id, u.id as app_user_id, u.username
       from webhooks w
       join users u on u.id = w.app_user_id
       where w.token_hash = $1
         and w.id = $2`,
      [hashAppToken(token), webhookId]
    );
    const webhook = result.rows[0];
    if (!webhook) return res.status(404).json({ error: 'webhook not found' });

    if (!applyWebhookRateLimit(req, res, webhook.webhook_id)) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    const overrides = getMessageOverrides(req.webhookPayload);
    if (overrides.error) return res.status(400).json({ error: overrides.error });

    const jsonAttachment = getLargeJsonAttachment(req.webhookPayload);
    const content = jsonAttachment
      ? 'Content attached as truncated.json'
      : executePayloadContent(req.webhookPayload);
    if (!content) {
      return res.status(400).json({ message: 'Cannot send an empty message' });
    }

    const message = limitWebhookContent(content);
    const payload = await deliverWebhookMessage(webhook, message, deliveryId, jsonAttachment, overrides);
    if (req.query.wait !== 'true') return res.status(204).end();
    res.status(200).json(payload);
  } catch (error) {
    console.error('failed to deliver webhook', error);
    res.status(500).json({ error: 'failed to deliver webhook' });
  }
}

async function updateWebhookMessage(req, res, remove = false) {
  const { webhookId, token, messageId } = req.params;
  const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
  if (!isUuid(webhookId) || !isUuid(messageId)) return res.status(404).json({ error: 'message not found' });
  try {
    const webhookResult = await pool.query(
      `select w.id, w.chat_id, w.app_user_id
       from webhooks w
       where w.id = $1 and w.token_hash = $2`,
      [webhookId, hashAppToken(token)]
    );
    const webhook = webhookResult.rows[0];
    if (!webhook) return res.status(404).json({ error: 'webhook not found' });

    const messageResult = await pool.query(
      `select id from messages
       where id = $1 and chat_id = $2 and sender_id = $3 and webhook_id = $4 and deleted_at is null`,
      [messageId, webhook.chat_id, webhook.app_user_id, webhookId]
    );
    if (!messageResult.rowCount) return res.status(404).json({ error: 'message not found' });

    if (remove) {
      await deleteAndBroadcastMessage({ messageId, chatId: webhook.chat_id });
      return res.status(204).end();
    }

    const content = executePayloadContent(req.webhookPayload);
    if (!content) return res.status(400).json({ error: 'message content is required' });
    const payload = await editAndBroadcastMessage({
      messageId,
      chatId: webhook.chat_id,
      content: limitWebhookContent(content)
    });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('failed to update webhook message', error);
    return res.status(500).json({ error: 'failed to update webhook message' });
  }
}

router.patch('/webhooks/:webhookId/:token/messages/:messageId', captureWebhookBody, (req, res) => updateWebhookMessage(req, res));
router.delete('/webhooks/:webhookId/:token/messages/:messageId', (req, res) => updateWebhookMessage(req, res, true));
router.post('/webhooks/:webhookId/:token', captureWebhookBody, (req, res) => receiveWebhook(req, res));

module.exports = router;
