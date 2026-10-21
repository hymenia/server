const { pool } = require('../db');

async function getMessageWithCallerRole(messageId, userId) {
  const r = await pool.query(
    `select m.id, m.chat_id, m.sender_id, m.sender_is_bot, m.content,
            m.deleted_at, m.edited_at, m.reply_to_id,
            c.space_id,
            sr.can_delete_any_message
     from messages m
     join chats c on c.id = m.chat_id
     left join space_members sm on sm.space_id = c.space_id and sm.user_id = $2
     left join space_roles sr on sr.space_id = c.space_id and sr.name = sm.role
     where m.id = $1`,
    [messageId, userId]
  );
  return r.rows[0] || null;
}

module.exports = { getMessageWithCallerRole };