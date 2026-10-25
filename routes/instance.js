const express = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { pool } = require('../db');
const { instanceName, publicUrl } = require('../config');
const { version } = require('../package.json');

const router = express.Router();

const FEDERATION_PROTOCOL_VERSION = 1;

// all values can be set in env
const SOFTWARE_NAME = process.env.SOFTWARE_NAME || 'Hymenia';
const INSTANCE_NAME = process.env.INSTANCE_NAME || instanceName;
const PUBLIC_URL = process.env.PUBLIC_URL || publicUrl;
const CAPABILITIES = (process.env.INSTANCE_CAPABILITIES || 'text-chat,voice,bots,webhooks')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

function gitCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch {
    return null;
  }
}

// git commit, package.json as a backup
const SOFTWARE_VERSION = gitCommit() || version;

let keyPromise = null;

async function loadSigningKey() {
  const select = () =>
    pool.query('select private_key, public_key from instance_keys where singleton = true');

  let r = await select();
  if (r.rows.length === 0) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    await pool.query(
      'insert into instance_keys (singleton, private_key, public_key) values (true, $1, $2) on conflict (singleton) do nothing',
      [
        privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey.export({ type: 'spki', format: 'pem' })
      ]
    );
    r = await select();
  }

  return {
    privateKey: crypto.createPrivateKey(r.rows[0].private_key),
    publicKey: r.rows[0].public_key
  };
}

function getSigningKey() {
  keyPromise ??= loadSigningKey().catch((error) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

router.get('/.well-known/hymenia', async (req, res) => {
  const nonce = req.query.nonce === undefined ? null : String(req.query.nonce);
  if (nonce !== null && !NONCE_RE.test(nonce)) {
    return res.status(400).json({ error: 'nonce must be 8 to 128 letters, digits, - or _' });
  }

  try {
    const result = await pool.query(
      'select instance_id, created_at from instance_id where singleton = true'
    );
    const identity = result.rows[0];
    if (!identity) {
      return res.status(503).json({ error: 'instance identity is not initialized' });
    }

    const key = await getSigningKey();

    const body = JSON.stringify({
      federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
      instance: {
        id: identity.instance_id,
        name: INSTANCE_NAME,
        url: PUBLIC_URL,
        publicKey: key.publicKey
      },
      software: {
        name: SOFTWARE_NAME,
        version: SOFTWARE_VERSION
      },
      capabilities: CAPABILITIES,
      createdAt: identity.created_at,
      nonce
    });

    const signature = crypto.sign(null, Buffer.from(body), key.privateKey).toString('base64');

    // shouldnt be cached
    res.set('Cache-Control', nonce ? 'no-store' : 'public, max-age=300');
    res.set('X-Hymenia-Signature', signature);
    res.type('application/json').send(body);
  } catch (error) {
    console.error('failed to load instance metadata', error);
    res.status(500).json({ error: 'failed to load instance metadata' });
  }
});

module.exports = router;