const express = require('express');
const { hashPassword, comparePassword } = require('../hash');
const { pool } = require('../db');
const { authenticateToken, blockApps, isFirstUser } = require('../middleware/auth');
const { normalizeUsername } = require('../utils/tokens');
const { validateAvatarDataUrl, getDefaultAvatar } = require('../utils/avatar');
const { generateVerificationToken, hashVerificationToken, sendVerificationEmail, isDisposableEmail } = require('../utils/email');

const router = express.Router();
const GLOBAL_ROLES = new Set(['verified', 'developer']);

async function requireDeveloper(req, res, next) {
  try {
    const result = await pool.query('select global_roles from users where id = $1', [req.user.id]);
    if (!result.rows[0]?.global_roles?.includes('developer')) {
      return res.status(403).json({ error: 'developer role required' });
    }
    next();
  } catch (e) {
    console.error('failed to verify developer role', e);
    res.status(500).json({ error: 'failed to verify permissions' });
  }
}

router.patch('/users/:username/roles', authenticateToken, blockApps, requireDeveloper, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const roles = Array.isArray(req.body?.roles) ? [...new Set(req.body.roles)] : null;
  if (!username || !roles || roles.some((role) => typeof role !== 'string' || !GLOBAL_ROLES.has(role))) {
    return res.status(400).json({ error: 'roles must be an array containing only verified or developer' });
  }

  try {
    const result = await pool.query(
      `update users set global_roles = $1 where username = $2
       returning username, display_name, global_roles`,
      [roles, username]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error('failed to update global roles', e);
    res.status(500).json({ error: 'failed to update global roles' });
  }
});

router.get('/profile/:username', async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  try {
    const result = await pool.query(
      'select username, display_name, bio, is_bot, global_roles from users where username = $1',
      [username]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error('failed to fetch public profile', e);
    res.status(500).json({ error: 'failed to fetch profile' });
  }
});

router.get('/account/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `select u.id, u.username, u.display_name, u.bio, u.avatar_url, u.global_roles,
              u.email, u.email_verified_at,
              u.id = (select fh.id
                        from users fh
                       where fh.is_bot = false
                       order by fh.created_at asc, fh.id asc
                       limit 1) as is_instance_owner
         from users u
        where u.id = $1`,
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    const row = result.rows[0];
    res.json({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      bio: row.bio,
      avatar_url: row.avatar_url,
      global_roles: row.global_roles,
      email: row.email,
      email_verified: !!row.email_verified_at,
      is_instance_owner: !!row.is_instance_owner
    });
  } catch (e) {
    console.error('failed to fetch profile', e);
    res.status(500).json({ error: 'failed to fetch profile' });
  }
});

router.patch('/account/profile', authenticateToken, blockApps, async (req, res) => {
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  const bio = typeof req.body?.bio === 'string' ? req.body.bio.trim() : '';

  if (displayName.length > 80) {
    return res.status(400).json({ error: 'display name must be 80 characters or fewer' });
  }
  if (bio.length > 500) {
    return res.status(400).json({ error: 'bio must be 500 characters or fewer' });
  }

  try {
    const result = await pool.query(
      `update users
       set display_name = nullif($1, ''), bio = nullif($2, '')
       where id = $3
      returning id, username, display_name, bio, avatar_url, global_roles`,
      [displayName, bio, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error('failed to update profile', e);
    res.status(500).json({ error: 'failed to update profile' });
  }
});

router.get('/avatar/:username', async (req, res) => {
  const username = normalizeUsername(req.params.username);

  const sendAvatar = (buffer, mime, etag) => {
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.send(buffer);
  };

  if (!username) {
    const d = getDefaultAvatar();
    return sendAvatar(d.buffer, d.mime, d.etag);
  }

  try {
    const r = await pool.query('select avatar_url from users where username = $1', [username]);
    const avatarUrl = r.rows[0]?.avatar_url;

    if (!avatarUrl) {
      const d = getDefaultAvatar();
      return sendAvatar(d.buffer, d.mime, d.etag);
    }

    const match = avatarUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      const d = getDefaultAvatar();
      return sendAvatar(d.buffer, d.mime, d.etag);
    }

    const [, mime, base64] = match;
    const crypto = require('crypto');
    const buffer = Buffer.from(base64, 'base64');
    const etag = crypto.createHash('md5').update(buffer).digest('hex');
    sendAvatar(buffer, mime, etag);
  } catch (e) {
    console.error('failed to fetch avatar', e);
    const d = getDefaultAvatar();
    sendAvatar(d.buffer, d.mime, d.etag);
  }
});

router.post('/account/avatar', authenticateToken, async (req, res) => {
  const avatarUrl = req.body?.avatarUrl;
  const validationError = validateAvatarDataUrl(avatarUrl);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    await pool.query('update users set avatar_url = $1 where id = $2', [avatarUrl, req.user.id]);
    res.json({ avatarUrl });
  } catch (e) {
    console.error('failed to update avatar', e);
    res.status(500).json({ error: 'failed to update avatar' });
  }
});

router.post('/account/avatar/delete', authenticateToken, async (req, res) => {
  try {
    await pool.query('update users set avatar_url = null where id = $1', [req.user.id]);
    res.json({ message: 'avatar removed' });
  } catch (e) {
    console.error('failed to remove avatar', e);
    res.status(500).json({ error: 'failed to remove avatar' });
  }
});

router.post('/account/password', authenticateToken, blockApps, async (req, res) => {
  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ error: 'current password and new password (min 8 chars) are required' });
  }

  try {
    const userRes = await pool.query('select id, password_hash from users where id = $1', [req.user.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    const match = await comparePassword(currentPassword, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'incorrect current password' });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('update users set password_hash = $1 where id = $2', [newHash, req.user.id]);

    res.json({ message: 'password updated successfully' });
  } catch (e) {
    console.error('failed to update password', e);
    res.status(500).json({ error: 'failed to update password' });
  }
});

router.post('/account/delete', authenticateToken, blockApps, async (req, res) => {
  const password = req.body?.password;

  if (typeof password !== 'string') {
    return res.status(400).json({ error: 'password confirmation is required' });
  }

  try {
    const userRes = await pool.query('select id, password_hash, global_roles from users where id = $1', [req.user.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    const match = await comparePassword(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'incorrect password' });
    }
    if (await isFirstUser(req.user.id)) {
      return res.status(400).json({ error: 'the first account created' });
    }
    if (user.global_roles.includes('admin')) {
      const remaining = await pool.query(
        `select count(*)::int as total
           from users
          where not is_bot
            and id <> $1
            and global_roles @> array['admin']::text[]`,
        [user.id]
      );
      if (remaining.rows[0].total === 0) {
        return res.status(400).json({ error: 'promote another admin before deleting the last admin account' });
      }
    }

    await pool.query('delete from users where id = $1', [req.user.id]);

    res.json({ message: 'account deleted successfully' });
  } catch (e) {
    console.error('failed to delete account', e);
    res.status(500).json({ error: 'failed to delete account' });
  }
});

router.get('/account/email', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'select email, email_verified_at from users where id = $1',
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    const row = result.rows[0];
    res.json({
      email: row.email,
      verified: !!row.email_verified_at,
      verifiedAt: row.email_verified_at
    });
  } catch (e) {
    console.error('failed to fetch email', e);
    res.status(500).json({ error: 'failed to fetch email' });
  }
});

router.post('/account/email', authenticateToken, blockApps, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email is required' });
  }
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: 'disposable or temporary email addresses are not allowed' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const existing = await client.query(
      'select id from users where lower(email) = $1 and id != $2',
      [email, req.user.id]
    );
    if (existing.rowCount > 0) {
      await client.query('rollback');
      return res.status(409).json({ error: 'email already in use' });
    }

    await client.query(
      'update users set email = $1, email_verified_at = null where id = $2',
      [email, req.user.id]
    );

    const token = generateVerificationToken();
    const tokenHash = hashVerificationToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(
      'delete from email_verification_tokens where user_id = $1',
      [req.user.id]
    );

    await client.query(
      'insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)',
      [req.user.id, tokenHash, expiresAt]
    );

    const origin = req.headers['origin'] || `${req.protocol}://${req.get('host')}`;
    const sent = await sendVerificationEmail(email, token, origin);

    if (!sent) {
      await client.query('rollback');
      return res.status(500).json({ error: 'failed to send verification email' });
    }

    await client.query('commit');
    res.json({ message: 'verification email sent', email });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('failed to send verification email', e);
    res.status(500).json({ error: 'failed to send verification email' });
  } finally {
    client.release();
  }
});

router.post('/account/email/verify', authenticateToken, blockApps, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    return res.status(400).json({ error: 'verification token is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const tokenHash = hashVerificationToken(token);
    const tokenRes = await client.query(
      `select user_id, expires_at from email_verification_tokens
       where user_id = $1 and token_hash = $2`,
      [req.user.id, tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      await client.query('rollback');
      return res.status(401).json({ error: 'invalid or expired token' });
    }

    const tokenRow = tokenRes.rows[0];
    if (new Date() > new Date(tokenRow.expires_at)) {
      await client.query('rollback');
      return res.status(401).json({ error: 'token expired' });
    }

    const emailRes = await client.query(
      'select email from users where id = $1',
      [req.user.id]
    );
    const email = emailRes.rows[0]?.email;

    if (!email) {
      await client.query('rollback');
      return res.status(400).json({ error: 'no email set' });
    }

    if (isDisposableEmail(email)) {
      await client.query('rollback');
      await pool.query('update users set email = null, email_verified_at = null where id = $1', [req.user.id]).catch(() => {});
      return res.status(400).json({ error: 'disposable or temporary email addresses are not allowed' });
    }

    await client.query(
      'update users set email_verified_at = now() where id = $1',
      [req.user.id]
    );

    await client.query(
      'delete from email_verification_tokens where user_id = $1',
      [req.user.id]
    );

    await client.query('commit');
    res.json({ message: 'email verified', email });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('failed to verify email', e);
    res.status(500).json({ error: 'failed to verify email' });
  } finally {
    client.release();
  }
});

module.exports = router;
