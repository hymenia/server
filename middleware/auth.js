const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { jwtSecret, emailVerificationRequired } = require('../config');
const { hashAppToken } = require('../utils/tokens');

async function resolveModeration(userId) {
  const r = await pool.query(
    'select moderation_status, moderation_expires_at from users where id = $1',
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;

  let status = row.moderation_status;
  if (status === 3 && row.moderation_expires_at && new Date() > new Date(row.moderation_expires_at)) {
    await pool.query(
      'update users set moderation_status = 0, moderation_reason = null, moderation_expires_at = null, moderated_by = null where id = $1',
      [userId]
    );
    status = 0;
  }
  return status;
}

function moderationBlock(status) {
  if (status === 2) return 'Your account has been banned.';
  if (status === 3) return 'Your account is currently suspended.';
  return null;
}

async function authenticateCredentials(authHeader) {
  if (!authHeader) {
    return { status: 401, error: 'token required' };
  }

  if (authHeader.startsWith('App ')) {
    const token = authHeader.slice(4).trim();
    if (!token) return { status: 401, error: 'token required' };

    const r = await pool.query(
      `update app_tokens t
          set last_used_at = now()
         from users u
        where t.token_hash = $1
          and u.id = t.app_user_id
          and u.is_bot = true
      returning u.id, u.username, u.app_owner_id`,
      [hashAppToken(token)]
    );
    if (r.rowCount === 0) {
      return { status: 401, error: 'invalid token' };
    }

    const app = r.rows[0];
    if (!app.app_owner_id) {
      return { status: 401, error: 'invalid token' };
    }

    const [appStatus, ownerStatus] = await Promise.all([
      resolveModeration(app.id),
      resolveModeration(app.app_owner_id)
    ]);
    if (appStatus === null || ownerStatus === null) {
      return { status: 401, error: 'invalid token' };
    }

    const blocked = moderationBlock(appStatus) || moderationBlock(ownerStatus);
    if (blocked) {
      return { status: 403, error: blocked };
    }

    if (!(await isUserEmailVerified(app.app_owner_id))) {
      return { status: 403, error: 'the app owner must verify their email' };
    }

    return {
      user: {
        id: app.id,
        username: app.username,
        isApp: true,
        appOwnerId: app.app_owner_id,
        moderationStatus: appStatus === 1 || ownerStatus === 1 ? 1 : 0
      }
    };
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { status: 401, error: 'token required' };
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (e) {
    return { status: 401, error: 'invalid or expired token' };
  }

  const status = await resolveModeration(payload.id);
  if (status === null) {
    return { status: 401, error: 'user not found' };
  }

  const blocked = moderationBlock(status);
  if (blocked) {
    return { status: 403, error: blocked };
  }

  return { user: { ...payload, isApp: false, moderationStatus: status } };
}

async function authenticateToken(req, res, next) {
  try {
    const result = await authenticateCredentials(req.headers['authorization']);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    req.user = result.user;
    next();
  } catch (e) {
    console.error('failed to authenticate', e);
    res.status(500).json({ error: 'failed to authenticate' });
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
  authenticateCredentials,
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