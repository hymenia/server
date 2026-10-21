const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { jwtSecret } = require('../config');
const { hashAppToken } = require('../utils/tokens');
const { authRateLimit } = require('../utils/authRateLimit');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'token required' });
  }

  if (authHeader.startsWith('App ')) {
    const token = authHeader.slice(4).trim();
    if (!token) return res.status(401).json({ error: 'token required' });

    try {
      const hash = hashAppToken(token);
      const r = await pool.query(
        `select u.id, u.username, u.is_bot, u.app_owner_id, bt.id as token_id
         from app_tokens bt join users u on u.id = bt.app_user_id
         where bt.token_hash = $1`,
        [hash]
      );
      const row = r.rows[0];
      if (!row) return res.status(401).json({ error: 'invalid app token' });

      pool.query('update app_tokens set last_used_at = now() where id = $1', [row.token_id]).catch(() => {});

      req.user = { id: row.id, username: row.username, isApp: true, appOwnerId: row.app_owner_id };
      return next();
    } catch (e) {
      console.error('app token auth error', e);
      return res.status(401).json({ error: 'invalid app token' });
    }
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'token required' });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    req.user.isApp = false;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

function blockApps(req, res, next) {
  if (req.user?.isApp) {
    return res.status(403).json({ error: 'apps cannot perform this action' });
  }
  next();
}

async function getSpaceMembership(spaceId, userId) {
  const r = await pool.query(
    'select role from space_members where space_id = $1 and user_id = $2',
    [spaceId, userId]
  );
  return r.rows[0]?.role || null;
}

function requireSpaceAccess(minRoles) {
  return async (req, res, next) => {
    const { spaceId } = req.params;
    try {
      const role = await getSpaceMembership(spaceId, req.user.id);
      if (role) {
        if (!minRoles || minRoles.includes(role)) {
          req.spaceRole = role;
          return next();
        }
        return res.status(403).json({ error: 'insufficient permissions in this space' });
      }

      if (!minRoles) {
        const spaceRes = await pool.query('select visibility from spaces where id = $1', [spaceId]);
        if (spaceRes.rowCount === 0) {
          return res.status(404).json({ error: 'space not found' });
        }
        if (spaceRes.rows[0].visibility === 'public') {
          req.spaceRole = null;
          return next();
        }
      }

      return res.status(403).json({ error: 'you are not a member of this space' });
    } catch (e) {
      console.error('failed to check space access', e);
      res.status(500).json({ error: 'failed to verify space permissions' });
    }
  };
}

async function canAccessChat(chatId, userId) {
  const r = await pool.query(
    `select s.visibility, sm.role
     from chats c
     join spaces s on s.id = c.space_id
     left join space_members sm on sm.space_id = s.id and sm.user_id = $2
     where c.id = $1`,
    [chatId, userId]
  );
  const row = r.rows[0];
  if (!row) return false;
  return row.visibility === 'public' || !!row.role;
}

module.exports = {
  authenticateToken,
  blockApps,
  authRateLimit,
  getSpaceMembership,
  requireSpaceAccess,
  canAccessChat
};
