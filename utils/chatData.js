const { pool } = require('../db');

async function chatExists(chatId) {
  const r = await pool.query('select 1 from chats where id = $1', [chatId]);
  return r.rowCount > 0;
}

async function getChat(chatId) {
  const r = await pool.query('select id, space_id, type from chats where id = $1', [chatId]);
  return r.rows[0] || null;
}

module.exports = { chatExists, getChat };
