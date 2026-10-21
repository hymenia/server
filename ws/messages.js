const { pool } = require('../db');
const { broadcastToRoom } = require('./rooms');

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
      'select display_name, global_roles from users where id = $1',
      [senderId]
    );
    const senderDisplayName = senderResult.rows[0]?.display_name || null;
    const senderGlobalRoles = senderResult.rows[0]?.global_roles || [];

    let replyTo = null;
    if (replyToId) {
      const replyRes = await client.query(
        `select m.id, m.content, u.username as sender
         from messages m
         left join users u on u.id = m.sender_id
         where m.id = $1 and m.chat_id = $2`,
        [replyToId, chatId]
      );
      replyTo = replyRes.rows[0] || null;
      if (!replyTo) {
        const err = new Error('reply_to_id does not refer to a message in this chat');
        err.code = 'INVALID_REPLY_TO';
        throw err;
      }
    }

    const insertRes = await client.query(
      'insert into messages (sender_id, chat_id, content, reply_to_id) values ($1, $2, $3, $4) returning id, created_at',
      [senderId, chatId, content, replyTo ? replyTo.id : null]
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

    payload = {
      id: saved.id,
      sender: senderUsername,
      sender_display_name: senderDisplayName,
      sender_global_roles: senderGlobalRoles,
      sender_is_bot: isSenderApp,
      chat_id: chatId,
      content: content,
      created_at: saved.created_at,
      reply_to_id: replyTo ? replyTo.id : null,
      reply_to_sender: replyTo ? replyTo.sender : null,
      reply_to_content: replyTo ? replyTo.content : null,
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

module.exports = { createAndBroadcastMessage, editAndBroadcastMessage, deleteAndBroadcastMessage };
