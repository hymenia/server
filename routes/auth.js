const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { hashPassword, comparePassword, DUMMY_HASH } = require('../hash');
const { pool } = require('../db');
const { jwtSecret, webauthnOrigins, webauthnRpIDForOrigin } = require('../config');
const { authenticateToken, blockApps } = require('../middleware/auth');
const { normalizeUsername, issueToken: issueTokenRaw } = require('../utils/tokens');
const { verifyHCaptcha } = require('../utils/hcaptcha');
const {
  generateVerificationToken,
  hashVerificationToken,
  sendVerificationEmail,
  isDisposableEmail
} = require('../utils/email');

const router = express.Router();

function issueToken(user) {
  return issueTokenRaw(user, jwtSecret);
}

router.get('/hcaptcha', (req, res) => {
  res.json({
    enabled: !!process.env.HCAPTCHA_SECRET,
    sitekey: process.env.HCAPTCHA_SITEKEY || null
  });
});

router.post('/register', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const hcaptchaToken = typeof req.body?.hcaptcha === 'string' ? req.body.hcaptcha : null;
  if (!username || username.length > 80 || typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email is required' });
  }
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: 'disposable or temporary email addresses are not allowed' });
  }
  const clientIp = req.headers['cf-connecting-ip'] || req.ip;
  if (!(await verifyHCaptcha(hcaptchaToken, clientIp))) {
    return res.status(400).json({ error: 'captcha verification failed' });
  }
  try {
    const existing = await pool.query('select id from users where username = $1', [username]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'username already taken' });
    }
    const existingEmail = await pool.query('select id from users where lower(email) = $1', [email]);
    if (existingEmail.rowCount > 0) {
      return res.status(409).json({ error: 'email already in use' });
    }

    const hash = await hashPassword(password);

    const result = await pool.query(
      'insert into users (username, password_hash, email) values ($1, $2, $3) returning id, username, created_at, avatar_url, email',
      [username, hash, email]
    );
    const user = result.rows[0];

    const verifyToken = generateVerificationToken();
    const tokenHash = hashVerificationToken(verifyToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const origin = req.headers['origin'] || `${req.protocol}://${req.get('host')}`;
    const sent = await sendVerificationEmail(email, verifyToken, origin);

    if (!sent) {
      await pool.query('delete from users where id = $1', [user.id]).catch(() => {});
      return res.status(500).json({ error: 'failed to send verification email' });
    }

    await pool.query(
      'insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    const token = issueToken(user);
    res.status(201).json({ user, token });
  } catch (e) {
    if (e.code === '23505') {
      const error = e.constraint === 'users_email_lower_unique' ? 'email already in use' : 'username already taken';
      return res.status(409).json({ error });
    }
    console.error('failed to register user', e);
    res.status(500).json({ error: 'failed to register user' });
  }
});

router.post('/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const hcaptchaToken = typeof req.body?.hcaptcha === 'string' ? req.body.hcaptcha : null;

  // any password shape is fine here so wrong answers all look the same
  if (!username || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const clientIp = req.headers['cf-connecting-ip'] || req.ip;
  if (!(await verifyHCaptcha(hcaptchaToken, clientIp))) {
    return res.status(400).json({ error: 'captcha verification failed' });
  }

  try {
    let r = await pool.query(
      'select id, username, password_hash, avatar_url from users where username = $1',
      [username]
    );
    const user = r.rows[0];

    if (!user) {
      await comparePassword(password, DUMMY_HASH);
      return res.status(401).json({ error: 'invalid username or password' });
    }
    if (!(await comparePassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const token = issueToken(user);
    res.json({ token, username: user.username, avatarUrl: user.avatar_url });
  } catch (e) {
    console.error('failed to log in', e);
    res.status(500).json({ error: 'failed to log in' });
  }
});

async function getPasskeyUser(username) {
  const result = await pool.query(
    'select id, username, avatar_url from users where username = $1',
    [username]
  );
  return result.rows[0];
}

router.post('/passkey/register/options', authenticateToken, blockApps, async (req, res) => {
  try {
    const user = await getPasskeyUser(req.user.username);
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    const credentials = await pool.query(
      'select credential_id, transports from passkeys where user_id = $1',
      [user.id]
    );
    const options = await generateRegistrationOptions({
      rpName: 'Hymenia',
      rpID: webauthnRpIDForOrigin(req.get('origin')),
      userName: user.username,
      userDisplayName: user.username,
      userID: Buffer.from(user.id.replaceAll('-', ''), 'hex'),
      attestationType: 'none',
      excludeCredentials: credentials.rows.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });

    await pool.query(
      "insert into passkey_challenges (user_id, purpose, challenge, expires_at) values ($1, 'registration', $2, now() + interval '5 minutes')",
      [user.id, options.challenge]
    );
    res.json(options);
  } catch (e) {
    console.error('failed to create passkey registration options', e);
    res.status(500).json({ error: 'failed to create passkey registration options' });
  }
});

router.post('/passkey/register/verify', authenticateToken, blockApps, async (req, res) => {
  try {
    const user = await getPasskeyUser(req.user.username);
    const challengeResult = await pool.query(
      "select id, challenge from passkey_challenges where user_id = $1 and purpose = 'registration' and expires_at > now() order by created_at desc limit 1",
      [user.id]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) {
      return res.status(400).json({ error: 'passkey registration has expired' });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge.challenge,
      expectedOrigin: webauthnOrigins,
      expectedRPID: webauthnRpIDForOrigin(req.get('origin'))
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'passkey registration was not verified' });
    }

    const { credential } = verification.registrationInfo;
    await pool.query(
      'insert into passkeys (credential_id, user_id, public_key, counter, transports) values ($1, $2, $3, $4, $5)',
      [credential.id, user.id, Buffer.from(credential.publicKey), credential.counter, req.body.response?.transports || []]
    );
    await pool.query('delete from passkey_challenges where id = $1', [challenge.id]);
    res.json({ verified: true });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'passkey is already registered' });
    }
    console.error('failed to verify passkey registration', e);
    res.status(400).json({ error: 'failed to verify passkey registration' });
  }
});

router.post('/passkey/login/options', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  try {
    const user = await getPasskeyUser(username);
    let allowCredentials = [];

    if (user) {
      const credentials = await pool.query(
        'select credential_id, transports from passkeys where user_id = $1',
        [user.id]
      );
      allowCredentials = credentials.rows.map((c) => ({
        id: c.credential_id,
        transports: c.transports
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: webauthnRpIDForOrigin(req.get('origin')),
      userVerification: 'preferred',
      allowCredentials
    });

    if (user) {
      await pool.query(
        "insert into passkey_challenges (user_id, purpose, challenge, expires_at) values ($1, 'authentication', $2, now() + interval '5 minutes')",
        [user.id, options.challenge]
      );
    }

    res.json(options);
  } catch (e) {
    console.error('failed to create passkey login options', e);
    res.status(500).json({ error: 'failed to create passkey login options' });
  }
});

router.post('/passkey/login/verify', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username || !req.body?.response) {
    return res.status(400).json({ error: 'username and passkey response are required' });
  }

  try {
    const user = await getPasskeyUser(username);
    if (!user) {
      return res.status(401).json({ error: 'invalid username or passkey' });
    }
    const challengeResult = await pool.query(
      "select id, challenge from passkey_challenges where user_id = $1 and purpose = 'authentication' and expires_at > now() order by created_at desc limit 1",
      [user.id]
    );
    const challenge = challengeResult.rows[0];
    const credentialResult = await pool.query(
      'select credential_id, public_key, counter, transports from passkeys where user_id = $1 and credential_id = $2',
      [user.id, req.body.response.id]
    );
    const stored = credentialResult.rows[0];
    if (!challenge || !stored) {
      return res.status(401).json({ error: 'invalid username or passkey' });
    }

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: webauthnOrigins,
      expectedRPID: webauthnRpIDForOrigin(req.get('origin')),
      credential: {
        id: stored.credential_id,
        publicKey: stored.public_key,
        counter: Number(stored.counter),
        transports: stored.transports
      }
    });
    if (!verification.verified) {
      return res.status(401).json({ error: 'invalid username or passkey' });
    }

    await pool.query('update passkeys set counter = $1 where credential_id = $2', [verification.authenticationInfo.newCounter, stored.credential_id]);
    await pool.query('delete from passkey_challenges where id = $1', [challenge.id]);
    res.json({ token: issueToken(user), username: user.username, avatarUrl: user.avatar_url });
  } catch (e) {
    console.error('failed to verify passkey login', e);
    res.status(401).json({ error: 'invalid username or passkey' });
  }
});

module.exports = { router, issueToken };
