const { pool } = require('../db');
const { broadcastToRoom } = require('./rooms');
const { reactionSummary } = require('../utils/reactions');
const { buildMessageByIdQuery } = require('../utils/messagePagination');

async function createAndBroadcastMessage(opts, db = pool) {
  const chatId = opts.chatId;
  const senderId = opts.senderId;
  const senderUsername = opts.senderUsername;
  const isSenderApp = opts.isSenderApp;
  const content = opts.content;
  const replyToId = opts.replyToId;
  const attachments = opts.attachments || [];

  const client = await db.connect();
  let payload;
  try {
    await client.query('begin');

    const senderResult = await client.query(
      'select display_name, global_roles, email_verified_at from users where id = $1',
      [senderId]
    );

    if (!isSenderApp && !opts.webhookId && !senderResult.rows[0]?.email_verified_at) {
      const err = new Error('email verification required to send messages');
      err.code = 'EMAIL_NOT_VERIFIED';
      throw err;
    }

    let replyTarget = null;
    if (replyToId) {
      const replyRes = await client.query(
        'select id from messages where id = $1 and chat_id = $2',
        [replyToId, chatId]
      );
      replyTarget = replyRes.rows[0] || null;
      if (!replyTarget) {
        const err = new Error('reply_to_id does not refer to a message in this chat');
        err.code = 'INVALID_REPLY_TO';
        throw err;
      }
    }

    const insertRes = await client.query(
      `insert into messages
       (sender_id, chat_id, content, reply_to_id, webhook_id, sender_name_override, sender_avatar_url_override)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        senderId,
        chatId,
        content,
        replyTarget ? replyTarget.id : null,
        opts.webhookId || null,
        opts.senderNameOverride || null,
        opts.senderAvatarUrl || null
      ]
    );
    const saved = insertRes.rows[0];
    const attachmentRows = [];
    for (const attachment of attachments) {
      const attachmentResult = await client.query(
        `insert into attachments
         (message_id, uploader_id, original_name, mime_type, size_bytes, storage_key)
         values ($1, $2, $3, $4, $5, $6)
         returning id, original_name, mime_type, size_bytes`,
        [saved.id, attachment.uploaderId, attachment.originalName, attachment.mimeType, attachment.sizeBytes, attachment.storageKey]
      );
      attachmentRows.push(attachmentResult.rows[0]);
    }

    const q = buildMessageByIdQuery(saved.id);
    const fullRes = await client.query(q.text, q.params);
    const row = fullRes.rows[0];

    payload = {
      ...row,
      sender: senderUsername || row.sender,
      sender_display_name: opts.senderDisplayName || row.sender_display_name,
      sender_is_bot: !!isSenderApp,
      attachments: attachmentRows.map((attachment) => ({
        id: attachment.id,
        name: attachment.original_name,
        mimeType: attachment.mime_type,
        size: Number(attachment.size_bytes),
        url: `/api/attachments/${attachment.id}`
      }))
    };

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  broadcastToRoom(chatId, payload);
  return payload;
}

async function editAndBroadcastMessage(opts) {
  const { messageId, chatId, content } = opts;

  const r = await pool.query(
    `update messages
     set content = $1, edited_at = now()
     where id = $2 and deleted_at is null
     returning id, edited_at`,
    [content, messageId]
  );
  const row = r.rows[0];
  if (!row) {
    const err = new Error('message not found');
    err.code = 'MESSAGE_NOT_FOUND';
    throw err;
  }

  const payload = {
    event: 'message_edited',
    id: row.id,
    chat_id: chatId,
    content,
    edited_at: row.edited_at
  };

  broadcastToRoom(chatId, payload);

  return payload;
}

async function deleteAndBroadcastMessage(opts) {
  const { messageId, chatId } = opts;

  const r = await pool.query(
    `update messages
     set content = '', deleted_at = now()
     where id = $1 and deleted_at is null
     returning id, deleted_at`,
    [messageId]
  );
  const row = r.rows[0];
  if (!row) {
    const err = new Error('message not found');
    err.code = 'MESSAGE_NOT_FOUND';
    throw err;
  }

  const payload = {
    event: 'message_deleted',
    id: row.id,
    chat_id: chatId,
    deleted_at: row.deleted_at
  };

  broadcastToRoom(chatId, payload);

  return payload;
}

async function reactAndBroadcast(opts) {
  const { messageId, chatId, userId, emoji, add } = opts;

  if (add) {
    await pool.query(
      `insert into message_reactions (message_id, user_id, emoji)
       values ($1, $2, $3)
       on conflict do nothing`,
      [messageId, userId, emoji]
    );
  } else {
    await pool.query(
      'delete from message_reactions where message_id = $1 and user_id = $2 and emoji = $3',
      [messageId, userId, emoji]
    );
  }

  const payload = {
    event: 'reaction_update',
    message_id: messageId,
    chat_id: chatId,
    emoji,
    user_id: userId,
    added: !!add,
    reactions: await reactionSummary(messageId)
  };

  broadcastToRoom(chatId, payload);

  return payload;
}

module.exports = { createAndBroadcastMessage, editAndBroadcastMessage, deleteAndBroadcastMessage, reactAndBroadcast };