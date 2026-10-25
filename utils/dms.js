const { pool } = require('../db');

// true if the user is one of the two people in a dm
async function canAccessDm(chatId, userId) {
  const r = await pool.query(
    'select 1 from dm_members where chat_id = $1 and user_id = $2',
    [chatId, userId]
  );
  return r.rowCount > 0;
}

module.exports = { canAccessDm };