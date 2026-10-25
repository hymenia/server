const express = require('express');
const { pool } = require('../db');
const { authenticateToken, blockApps, requireSpaceAccess, getSpaceMembership, requireVerifiedEmail } = require('../middleware/auth');
const { normalizeUsername, generateInviteCode } = require('../utils/tokens');

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `select s.id, s.name, s.visibility, s.created_at, sm.role
       from spaces s
       join space_members sm on sm.space_id = s.id and sm.user_id = $1
       order by s.created_at asc`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to fetch spaces', e);
    res.status(500).json({ error: 'failed to fetch spaces' });
  }
});

router.get('/discover', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `select s.id, s.name, s.created_at
       from spaces s
       where s.visibility = 'public'
         and not exists (
           select 1 from space_members sm where sm.space_id = s.id and sm.user_id = $1
         )
       order by s.created_at asc`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to fetch discoverable spaces', e);
    res.status(500).json({ error: 'failed to fetch discoverable spaces' });
  }
});

router.post('/', authenticateToken, blockApps, requireVerifiedEmail('create a space'), async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const visibility = req.body?.visibility === 'public' ? 'public' : 'private';

  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'space name must be 1 to 80 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await client.query(
      'insert into spaces (name, owner_id, visibility) values ($1, $2, $3) returning id, name, visibility, created_at',
      [name, req.user.id, visibility]
    );
    const space = r.rows[0];
    await client.query(
      "insert into space_members (space_id, user_id, role) values ($1, $2, 'owner')",
      [space.id, req.user.id]
    );
    await client.query('commit');
    res.status(201).json({ ...space, role: 'owner' });
  } catch (e) {
    await client.query('rollback');
    console.error('failed to create space', e);
    res.status(500).json({ error: 'failed to create space' });
  } finally {
    client.release();
  }
});

router.post('/:spaceId/join', authenticateToken, blockApps, requireVerifiedEmail('join a space'), async (req, res) => {
  const { spaceId } = req.params;
  try {
    const spaceRes = await pool.query('select visibility from spaces where id = $1', [spaceId]);
    if (spaceRes.rowCount === 0) {
      return res.status(404).json({ error: 'space not found' });
    }
    if (spaceRes.rows[0].visibility !== 'public') {
      return res.status(403).json({ error: 'this space is private, you need an invite' });
    }
    await pool.query(
      "insert into space_members (space_id, user_id, role) values ($1, $2, 'member') on conflict (space_id, user_id) do nothing",
      [spaceId, req.user.id]
    );
    res.json({ message: 'joined space' });
  } catch (e) {
    console.error('failed to join space', e);
    res.status(500).json({ error: 'failed to join space' });
  }
});

router.get('/:spaceId/members', authenticateToken, requireSpaceAccess(['owner', 'admin', 'member']), async (req, res) => {
  const { spaceId } = req.params;
  try {
    const r = await pool.query(
      `select u.id, u.username, u.is_bot, sm.role, sm.joined_at
       from space_members sm
       join users u on u.id = sm.user_id
       where sm.space_id = $1
       order by sm.joined_at asc`,
      [spaceId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to list space members', e);
    res.status(500).json({ error: 'failed to list space members' });
  }
});

router.post('/:spaceId/members', authenticateToken, blockApps, requireSpaceAccess(['owner', 'admin']), async (req, res) => {
  const { spaceId } = req.params;
  const username = normalizeUsername(req.body?.username);
  const role = req.body?.role === 'admin' ? 'admin' : 'member';

  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (role === 'admin' && req.spaceRole !== 'owner') {
    return res.status(403).json({ error: 'only the space owner can add admins' });
  }

  try {
    const userRes = await pool.query('select id from users where username = $1', [username]);
    if (userRes.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    await pool.query(
      `insert into space_members (space_id, user_id, role) values ($1, $2, $3)
       on conflict (space_id, user_id) do update set role = excluded.role`,
      [spaceId, userRes.rows[0].id, role]
    );
    res.status(201).json({ message: 'member added' });
  } catch (e) {
    console.error('failed to add space member', e);
    res.status(500).json({ error: 'failed to add space member' });
  }
});

router.post('/:spaceId/invites', authenticateToken, blockApps, requireSpaceAccess(['owner', 'admin']), async (req, res) => {
  const { spaceId } = req.params;
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  const maxUses = Number.isInteger(req.body?.maxUses) && req.body.maxUses > 0 ? req.body.maxUses : null;
  const expiresInHours = Number.isFinite(req.body?.expiresInHours) && req.body.expiresInHours > 0 ? req.body.expiresInHours : null;

  if (role === 'admin' && req.spaceRole !== 'owner') {
    return res.status(403).json({ error: 'only the space owner can create admin invites' });
  }

  try {
    const code = generateInviteCode();
    const r = await pool.query(
      `insert into space_invites (space_id, code, role, created_by, max_uses, expires_at)
       values ($1, $2, $3, $4, $5, $6::interval + now())
       returning id, code, role, max_uses, uses_count, expires_at, created_at`,
      [spaceId, code, role, req.user.id, maxUses, expiresInHours ? `${expiresInHours} hours` : null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('failed to create invite', e);
    res.status(500).json({ error: 'failed to create invite' });
  }
});

router.get('/:spaceId/invites', authenticateToken, requireSpaceAccess(['owner', 'admin']), async (req, res) => {
  const { spaceId } = req.params;
  try {
    const r = await pool.query(
      `select id, code, role, max_uses, uses_count, expires_at, created_at
       from space_invites
       where space_id = $1
         and (expires_at is null or expires_at > now())
         and (max_uses is null or uses_count < max_uses)
       order by created_at desc`,
      [spaceId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to list invites', e);
    res.status(500).json({ error: 'failed to list invites' });
  }
});

router.delete('/:spaceId/invites/:inviteId', authenticateToken, blockApps, requireSpaceAccess(['owner', 'admin']), async (req, res) => {
  const { spaceId, inviteId } = req.params;
  try {
    const r = await pool.query('delete from space_invites where id = $1 and space_id = $2', [inviteId, spaceId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'invite not found' });
    res.json({ message: 'invite revoked' });
  } catch (e) {
    console.error('failed to revoke invite', e);
    res.status(500).json({ error: 'failed to revoke invite' });
  }
});

const inviteAcceptRouter = express.Router();
inviteAcceptRouter.post('/:code/accept', authenticateToken, blockApps, requireVerifiedEmail('join a space'), async (req, res) => {
  const { code } = req.params;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const inviteRes = await client.query(
      'select id, space_id, role, max_uses, uses_count, expires_at from space_invites where code = $1 for update',
      [code]
    );
    const invite = inviteRes.rows[0];
    if (!invite) {
      await client.query('rollback');
      return res.status(404).json({ error: 'invite not found or expired' });
    }
    if (invite.expires_at && new Date(invite.expires_at) <= new Date()) {
      await client.query('rollback');
      return res.status(410).json({ error: 'invite has expired' });
    }
    if (invite.max_uses !== null && invite.uses_count >= invite.max_uses) {
      await client.query('rollback');
      return res.status(410).json({ error: 'invite has reached its use limit' });
    }

    const existing = await client.query(
      'select role from space_members where space_id = $1 and user_id = $2',
      [invite.space_id, req.user.id]
    );
    if (existing.rowCount === 0) {
      await client.query(
        'insert into space_members (space_id, user_id, role) values ($1, $2, $3)',
        [invite.space_id, req.user.id, invite.role]
      );
      await client.query('update space_invites set uses_count = uses_count + 1 where id = $1', [invite.id]);
    }

    const spaceRes = await client.query('select id, name, visibility, created_at from spaces where id = $1', [invite.space_id]);
    await client.query('commit');
    res.json({ space: spaceRes.rows[0], alreadyMember: existing.rowCount > 0 });
  } catch (e) {
    await client.query('rollback');
    console.error('failed to accept invite', e);
    res.status(500).json({ error: 'failed to accept invite' });
  } finally {
    client.release();
  }
});

module.exports = { router, inviteAcceptRouter };
