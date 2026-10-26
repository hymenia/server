const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GLOBAL_ROLES = new Set(['admin', 'verified', 'developer', 'glee']);

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  const search = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 100) : '';
  const pattern = `%${escapeLike(search)}%`;
  const limit = parseInteger(req.query.limit, 50, 1, 100);
  const offset = parseInteger(req.query.offset, 0, 0, 1000000);

  try {
    const [usersResult, totalResult, summaryResult] = await Promise.all([
      pool.query(
        `select
           u.id,
           u.username,
           u.display_name,
           u.email,
           u.email_verified_at is not null as email_verified,
           u.global_roles,
           u.is_bot,
           u.app_owner_id,
           owner.username as app_owner_username,
           u.created_at,
           (select count(*)::int
              from space_members sm
             where sm.user_id = u.id) as space_count,
           (select count(*)::int
              from messages m
             where m.sender_id = u.id
               and m.deleted_at is null) as message_count,
           (select max(m.created_at)
              from messages m
             where m.sender_id = u.id) as last_message_at,
           (select count(*)::int
              from passkeys p
             where p.user_id = u.id) as passkey_count
         from users u
         left join users owner on owner.id = u.app_owner_id
         where $1 = ''
            or u.username ilike $2
            or coalesce(u.display_name, '') ilike $2
            or coalesce(u.email, '') ilike $2
         order by u.created_at desc
         limit $3 offset $4`,
        [search, pattern, limit, offset]
      ),
      pool.query(
        `select count(*)::int as total
           from users u
          where $1 = ''
             or u.username ilike $2
             or coalesce(u.display_name, '') ilike $2
             or coalesce(u.email, '') ilike $2`,
        [search, pattern]
      ),
      pool.query(
        `select
           count(*)::int as total,
           (count(*) filter (where email_verified_at is not null))::int as verified,
           (count(*) filter (where is_bot))::int as apps,
           (count(*) filter (where global_roles @> array['admin']::text[]))::int as admins
         from users`
      )
    ]);

    res.json({
      users: usersResult.rows,
      total: totalResult.rows[0]?.total || 0,
      summary: summaryResult.rows[0] || { total: 0, verified: 0, apps: 0, admins: 0 }
    });
  } catch (e) {
    console.error('failed to load users', e);
    res.status(500).json({ error: 'failed to load users' });
  }
});

router.patch('/users/:userId/roles', authenticateToken, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  if (!USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'invalid user id' });
  }

  const roles = Array.isArray(req.body?.roles) ? [...new Set(req.body.roles)] : null;
  if (!roles || roles.some((role) => typeof role !== 'string' || !GLOBAL_ROLES.has(role))) {
    return res.status(400).json({ error: 'roles must be an array containing only admin, verified, developer, or glee' });
  }

  try {
    const existing = await pool.query(
      'select id, username, is_bot, global_roles from users where id = $1',
      [userId]
    );
    const user = existing.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }
    if (user.is_bot && roles.length > 0) {
      return res.status(400).json({ error: 'app accounts cannot have global roles' });
    }
    if (user.id === req.user.id && !roles.includes('admin')) {
      return res.status(400).json({ error: 'you cannot remove your own admin role' });
    }

    const result = await pool.query(
      `update users set global_roles = $1 where id = $2
       returning id, username, global_roles`,
      [roles, userId]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('failed to update user roles', e);
    res.status(500).json({ error: 'failed to update user roles' });
  }
});

router.delete('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  if (!USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'invalid user id' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');

    const target = await client.query(
      'select id, username, is_bot, global_roles from users where id = $1 or app_owner_id = $1',
      [userId]
    );
    if (target.rowCount === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'user not found' });
    }
    const ids = target.rows.map((row) => row.id);
    const user = target.rows.find((row) => row.id === userId);

    if (user.global_roles.includes('admin')) {
      const remaining = await client.query(
        `select count(*)::int as total
           from users
          where not is_bot
            and global_roles @> array['admin']::text[]
            and not (id = any($1::uuid[]))`,
        [ids]
      );
      if (remaining.rows[0].total === 0) {
        await client.query('rollback');
        return res.status(400).json({ error: 'promote another admin before deleting the last admin account' });
      }
    }

    await client.query(
      `update messages set reply_to_id = null
       where reply_to_id in (
         select id from messages where sender_id = any($1::uuid[])
       )`,
      [ids]
    );
    await client.query(
      `update messages set webhook_id = null
       where webhook_id in (
         select id from webhooks where app_user_id = any($1::uuid[])
       )`,
      [ids]
    );
    await client.query('delete from message_reactions where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from attachments where uploader_id = any($1::uuid[])', [ids]);
    await client.query('delete from messages where sender_id = any($1::uuid[])', [ids]);
    await client.query('delete from webhooks where app_user_id = any($1::uuid[])', [ids]);
    await client.query('delete from app_invites where app_user_id = any($1::uuid[])', [ids]);
    await client.query('update app_invites set created_by = null where created_by = any($1::uuid[])', [ids]);
    await client.query('delete from space_invites where created_by = any($1::uuid[])', [ids]);
    await client.query('delete from space_members where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from passkeys where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from passkey_challenges where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from email_verification_tokens where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from app_tokens where app_user_id = any($1::uuid[])', [ids]);
    await client.query('update spaces set owner_id = null where owner_id = any($1::uuid[])', [ids]);
    await client.query('delete from users where id = any($1::uuid[])', [ids]);

    await client.query('commit');
    res.json({ deleted: true, user });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('failed to delete user', e);
    res.status(500).json({ error: 'failed to delete user' });
  } finally {
    client.release();
  }
});

module.exports = router;