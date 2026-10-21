const express = require('express');
const { pool } = require('../db');
const { hashPassword } = require('../hash');
const crypto = require('crypto');
const { authenticateToken, blockApps, getSpaceMembership } = require('../middleware/auth');
const { normalizeUsername, generateAppToken, hashAppToken, generateInviteCode } = require('../utils/tokens');

const router = express.Router();

router.post('/', authenticateToken, blockApps, async (req, res) => {
  const name = normalizeUsername(req.body?.name);
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'app name must be 1 to 80 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const randomHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
    const userResult = await client.query(
      `insert into users (username, password_hash, is_bot, app_owner_id)
       values ($1, $2, true, $3)
       returning id, username, created_at`,
      [name, randomHash, req.user.id]
    );
    const app = userResult.rows[0];

    const token = generateAppToken();
    const tokenHash = hashAppToken(token);
    await client.query(
      'insert into app_tokens (app_user_id, token_hash) values ($1, $2)',
      [app.id, tokenHash]
    );

    await client.query('commit');

    res.status(201).json({ app, token });
  } catch (e) {
    await client.query('rollback');
    if (e.code === '23505') return res.status(409).json({ error: 'a app with that name already exists' });
    console.error('failed to create app', e);
    res.status(500).json({ error: 'failed to create app' });
  } finally {
    client.release();
  }
});

router.get('/', authenticateToken, blockApps, async (req, res) => {
  try {
    const r = await pool.query(
      'select id, username, created_at from users where is_bot = true and app_owner_id = $1 order by created_at asc',
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to list apps', e);
    res.status(500).json({ error: 'failed to list apps' });
  }
});

router.post('/:appId/regenerate', authenticateToken, blockApps, async (req, res) => {
  const { appId } = req.params;
  try {
    const ownedCheck = await pool.query(
      'select id from users where id = $1 and is_bot = true and app_owner_id = $2',
      [appId, req.user.id]
    );
    if (ownedCheck.rowCount === 0) {
      return res.status(404).json({ error: 'app not found' });
    }

    const token = generateAppToken();
    const tokenHash = hashAppToken(token);
    await pool.query('delete from app_tokens where app_user_id = $1', [appId]);
    await pool.query('insert into app_tokens (app_user_id, token_hash) values ($1, $2)', [appId, tokenHash]);

    res.json({ token });
  } catch (e) {
    console.error('failed to regenerate app token', e);
    res.status(500).json({ error: 'failed to regenerate app token' });
  }
});

router.delete('/:appId', authenticateToken, blockApps, async (req, res) => {
  const { appId } = req.params;
  try {
    const r = await pool.query(
      'delete from users where id = $1 and is_bot = true and app_owner_id = $2',
      [appId, req.user.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'app not found' });
    }
    res.json({ message: 'app deleted' });
  } catch (e) {
    console.error('failed to delete app', e);
    res.status(500).json({ error: 'failed to delete app' });
  }
});

async function getOwnedApp(appId, ownerId) {
  const r = await pool.query(
    'select id, username from users where id = $1 and is_bot = true and app_owner_id = $2',
    [appId, ownerId]
  );
  return r.rows[0] || null;
}

router.post('/:appId/invites', authenticateToken, blockApps, async (req, res) => {
  const { appId } = req.params;
  try {
    const app = await getOwnedApp(appId, req.user.id);
    if (!app) {
      return res.status(404).json({ error: 'app not found' });
    }
    const code = generateInviteCode();
    const r = await pool.query(
      `insert into app_invites (app_user_id, code, created_by)
       values ($1, $2, $3)
       returning id, code, created_at`,
      [appId, code, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('failed to create app invite', e);
    res.status(500).json({ error: 'failed to create app invite' });
  }
});

router.get('/:appId/invites', authenticateToken, blockApps, async (req, res) => {
  const { appId } = req.params;
  try {
    const app = await getOwnedApp(appId, req.user.id);
    if (!app) {
      return res.status(404).json({ error: 'app not found' });
    }
    const r = await pool.query(
      'select id, code, created_at from app_invites where app_user_id = $1 order by created_at desc',
      [appId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to list app invites', e);
    res.status(500).json({ error: 'failed to list app invites' });
  }
});

router.delete('/:appId/invites/:inviteId', authenticateToken, blockApps, async (req, res) => {
  const { appId, inviteId } = req.params;
  try {
    const app = await getOwnedApp(appId, req.user.id);
    if (!app) {
      return res.status(404).json({ error: 'app not found' });
    }
    const r = await pool.query('delete from app_invites where id = $1 and app_user_id = $2', [inviteId, appId]);
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'invite not found' });
    }
    res.json({ message: 'invite revoked' });
  } catch (e) {
    console.error('failed to revoke app invite', e);
    res.status(500).json({ error: 'failed to revoke app invite' });
  }
});

const applicationsRouter = express.Router();

applicationsRouter.get('/:code', authenticateToken, blockApps, async (req, res) => {
  const { code } = req.params;
  try {
    const r = await pool.query(
      `select u.id as app_id, u.username as app_username
       from app_invites bi
       join users u on u.id = bi.app_user_id
       where bi.code = $1`,
      [code]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'invite not found' });
    }
    res.json({ app: { id: r.rows[0].app_id, username: r.rows[0].app_username } });
  } catch (e) {
    console.error('failed to look up app invite', e);
    res.status(500).json({ error: 'failed to look up app invite' });
  }
});

applicationsRouter.post('/:code/accept', authenticateToken, blockApps, async (req, res) => {
  const { code } = req.params;
  const spaceId = req.body?.spaceId;
  if (!spaceId) {
    return res.status(400).json({ error: 'spaceId is required' });
  }

  try {
    const inviteRes = await pool.query(
      `select u.id as app_id, u.username as app_username
       from app_invites bi
       join users u on u.id = bi.app_user_id
       where bi.code = $1`,
      [code]
    );
    if (inviteRes.rowCount === 0) {
      return res.status(404).json({ error: 'invite not found' });
    }
    const { app_id: appId, app_username: appUsername } = inviteRes.rows[0];

    const role = await getSpaceMembership(spaceId, req.user.id);
    if (!role || !['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'you must be an owner or admin of that space' });
    }

    const spaceRes = await pool.query('select id, name from spaces where id = $1', [spaceId]);
    if (spaceRes.rowCount === 0) {
      return res.status(404).json({ error: 'space not found' });
    }

    await pool.query(
      "insert into space_members (space_id, user_id, role) values ($1, $2, 'member') on conflict (space_id, user_id) do nothing",
      [spaceId, appId]
    );

    res.json({ message: 'app added to space', appUsername, spaceName: spaceRes.rows[0].name });
  } catch (e) {
    console.error('failed to accept app invite', e);
    res.status(500).json({ error: 'failed to accept app invite' });
  }
});

module.exports = { router, applicationsRouter };
