const MESSAGES_PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildMessagesPageQuery(chatId, beforeAt, beforeId) {
  const params = [chatId];
  let where = 'where m.chat_id = $1';

  if (beforeAt) {
    params.push(beforeAt, beforeId);
    where += ` and (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }

  // so the client can know if there's more messages to load
  params.push(MESSAGES_PAGE_SIZE + 1);
  return {
    text: `select m.id, u.username as sender,
              coalesce(m.sender_name_override, w.name, u.display_name, u.username) as sender_display_name,
              m.sender_avatar_url_override as sender_avatar_url,
              u.is_bot as sender_is_bot, u.global_roles as sender_global_roles,
              m.content, m.created_at, m.chat_id,
              m.edited_at, m.deleted_at,
              m.reply_to_id,
              coalesce(rw.name, ru.username) as reply_to_sender,
              rm.content as reply_to_content
      from messages m
      left join users u on u.id = m.sender_id
      left join webhooks w on w.id = m.webhook_id
      left join messages rm on rm.id = m.reply_to_id
      left join users ru on ru.id = rm.sender_id
      left join webhooks rw on rw.id = rm.webhook_id
      ${where}
      order by m.created_at desc, m.id desc
      limit $${params.length}`,
    params
  };
}

module.exports = { MESSAGES_PAGE_SIZE, UUID_RE, buildMessagesPageQuery };
