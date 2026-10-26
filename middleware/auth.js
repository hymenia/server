const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { jwtSecret, emailVerificationRequired } = require('../config');
const { hashAppToken } = require('../utils/tokens');

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
        `select u.id, u.username, u.is_bot, u.app_owner_id, u.moderation_status, u.moderation_expires_at, bt.id as token_id
         from app_tokens bt join users u on u.id = bt.app_user_id
         where bt.token_hash = $1`,
        [hash]
      );
      const row = r.rows[0];
      if (!row) return res.status(401).json({ error: 'invalid app token' });

      if (row.moderation_status === 2) {
        return res.status(403).json({ error: 'Account is banned' });
      }

      pool.query('update app_tokens set last_used_at = now() where id = $1', [row.token_id]).catch(() => {});

      req.user = { id: row.id, username: row.username, isApp: true, appOwnerId: row.app_owner_id, moderationStatus: row.moderation_status };
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
    const payload = jwt.verify(token, jwtSecret);
    
    const userRes = await pool.query(
      'select moderation_status, moderation_expires_at from users where id = $1',
      [payload.id]
    );
    const dbUser = userRes.rows[0];
    if (!dbUser) {
      return res.status(401).json({ error: 'user not found' });
    }

    let status = dbUser.moderation_status;
    let expiresAt = dbUser.moderation_expires_at;

    if (status === 3 && expiresAt && new Date() > new Date(expiresAt)) {
      await pool.query(
        'update users set moderation_status = 0, moderation_reason = null, moderation_expires_at = null, moderated_by = null where id = $1',
        [payload.id]
      );
      status = 0;
    }

    if (status === 2) {
      return res.status(403).json({ error: 'Your account has been banned.' });
    }
    if (status === 3) {
      return res.status(403).json({ error: 'Your account is currently suspended.' });
    }

    req.user = { ...payload, isApp: false, moderationStatus: status };
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

function requireNotLimited(req, res, next) {
  if (req.user?.moderationStatus === 1) {
    return res.status(403).json({ error: 'Your account is limited. You cannot perform this action.' });
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
    `select c.type, s.visibility, sm.role, dm.user_id as dm_user
     from chats c
     left join spaces s on s.id = c.space_id
     left join space_members sm on sm.space_id = s.id and sm.user_id = $2
     left join dm_members dm on dm.chat_id = c.id and dm.user_id = $2
     where c.id = $1`,
    [chatId, userId]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.type === 'dm') return !!row.dm_user;
  return row.visibility === 'public' || !!row.role;
}

async function isUserEmailVerified(userId) {
  if (!emailVerificationRequired) return true;
  if (!userId) return false;
  const r = await pool.query('select email_verified_at from users where id = $1', [userId]);
  return !!r.rows[0]?.email_verified_at;
}

function requireVerifiedEmail(actionOrReq, res, next) {
  if (!emailVerificationRequired) {
    if (typeof actionOrReq === 'string') {
      return (req, res, next) => next();
    }
    return next();
  }

  if (typeof actionOrReq === 'string') {
    const action = actionOrReq;
    return async (req, res, next) => {
      if (req.user?.isApp) return next();
      if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
      try {
        const verified = await isUserEmailVerified(req.user.id);
        if (!verified) {
          return res.status(403).json({ error: `email verification required to ${action}` });
        }
        next();
      } catch (e) {
        console.error('failed to check email verification', e);
        res.status(500).json({ error: 'failed to verify email status' });
      }
    };
  }

  const req = actionOrReq;
  if (req.user?.isApp) return next();
  if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
  isUserEmailVerified(req.user.id)
    .then((verified) => {
      if (!verified) {
        return res.status(403).json({ error: 'email verification required' });
      }
      next();
    })
    .catch((e) => {
      console.error('failed to check email verification', e);
      res.status(500).json({ error: 'failed to verify email status' });
    });
}

async function requireAdmin(req, res, next) {
  try {
    if (req.user?.isApp) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const r = await pool.query(
      "select 1 from users where id = $1 and 'admin' = any(global_roles)",
      [req.user.id]
    );
    if (!r.rows[0]) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
}

module.exports = {
  authenticateToken,
  blockApps,
  requireNotLimited,
  getSpaceMembership,
  requireSpaceAccess,
  canAccessChat,
  isUserEmailVerified,
  requireAdmin,
  requireVerifiedEmail
};