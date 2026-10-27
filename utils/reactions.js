const { pool } = require('../db');

async function reactionSummary(messageId, db = pool) {
  const r = await db.query(
    `select emoji, count(*)::int as count
       from message_reactions
      where message_id = $1
      group by emoji
      order by min(created_at), emoji`,
    [messageId]
  );
  return r.rows;
}

async function reactionsByMessageId(messageIds, viewerId, db = pool) {
  if (messageIds.length === 0) return new Map();
  const r = await db.query(
    `select message_id, emoji, count(*)::int as count, bool_or(user_id = $2::uuid) as me
       from message_reactions
      where message_id = any($1::uuid[])
      group by message_id, emoji
      order by message_id, min(created_at), emoji`,
    [messageIds, viewerId]
  );
  const byMessage = new Map();
  for (const row of r.rows) {
    const list = byMessage.get(row.message_id) || [];
    list.push({ emoji: row.emoji, count: row.count, me: row.me });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

module.exports = { reactionSummary, reactionsByMessageId };