const MESSAGES_PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGE_SELECT = `
  select m.id, m.sender_id, u.username as sender,
         coalesce(m.sender_name_override, w.name, u.display_name, u.username) as sender_display_name,
         m.sender_avatar_url_override as sender_avatar_url,
         u.is_bot as sender_is_bot, u.global_roles as sender_global_roles,
         m.content, m.created_at, m.chat_id,
         m.edited_at, m.deleted_at,
         m.webhook_id,
         m.reply_to_id,
         case when rm.id is null then null else json_build_object(
           'id',                   rm.id,
           'chat_id',              rm.chat_id,
           'created_at',           rm.created_at,
           'edited_at',            rm.edited_at,
           'deleted_at',           rm.deleted_at,
           'sender_id',            rm.sender_id,
           'sender',               coalesce(rw.name, ru.username),
           'sender_display_name',  coalesce(rm.sender_name_override, rw.name, ru.display_name, ru.username),
           'sender_avatar_url',    rm.sender_avatar_url_override,
           'sender_is_bot',        ru.is_bot,
           'sender_global_roles',  ru.global_roles,
           'webhook_id',           rm.webhook_id,
           'content',              case when rm.deleted_at is null then rm.content end
         ) end as reply_to
  from messages m
  left join users u on u.id = m.sender_id
  left join webhooks w on w.id = m.webhook_id
  left join messages rm on rm.id = m.reply_to_id
  left join users ru on ru.id = rm.sender_id
  left join webhooks rw on rw.id = rm.webhook_id
`;

function buildMessagesPageQuery(chatId, beforeAt, beforeId) {
  const params = [chatId];
  let where = 'where m.chat_id = $1 and m.deleted_at is null';

  if (beforeAt) {
    params.push(beforeAt, beforeId);
    where += ` and (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }

  // so the client can know if there's more messages to load
  params.push(MESSAGES_PAGE_SIZE + 1);
  return {
    text: `${MESSAGE_SELECT}
      ${where}
      order by m.created_at desc, m.id desc
      limit $${params.length}`,
    params
  };
}

function buildMessageByIdQuery(messageId) {
  return {
    text: `${MESSAGE_SELECT}
      where m.id = $1`,
    params: [messageId]
  };
}

module.exports = {
  MESSAGES_PAGE_SIZE,
  UUID_RE,
  buildMessagesPageQuery,
  buildMessageByIdQuery
};