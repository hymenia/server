const express = require('express');

const router = express.Router();

let lib = null;
async function altcha() {
  if (!lib) {
    const [core, pbkdf2] = await Promise.all([
      import('altcha-lib'),
      import('altcha-lib/algorithms/pbkdf2')
    ]);
    lib = { ...core, deriveKey: pbkdf2.deriveKey };
  }
  return lib;
}

function secrets() {
  return {
    hmacSignatureSecret: process.env.ALTCHA_HMAC_KEY,
    hmacKeySignatureSecret: process.env.ALTCHA_KEY_SECRET
  };
}

function parsePayload(payload) {
  if (typeof payload !== 'string' || !payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function verifyAltcha(payload) {
  const parsed = parsePayload(payload);
  if (!parsed?.challenge || !parsed?.solution) return false;
  try {
    const { verifySolution, deriveKey } = await altcha();
    const result = await verifySolution({
      challenge: parsed.challenge,
      solution: parsed.solution,
      deriveKey,
      ...secrets()
    });
    return result.verified === true;
  } catch (e) {
    console.error('altcha verify failed', e);
    return false;
  }
}

router.get('/altcha/challenge', async (req, res) => {
  try {
    const { createChallenge, randomInt, deriveKey } = await altcha();
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 5000,
      counter: randomInt(5000, 10000),
      deriveKey,
      ...secrets()
    });
    res.json(challenge);
  } catch (e) {
    console.error('failed to create altcha challenge', e);
    res.status(500).json({ error: 'failed to create challenge' });
  }
});

module.exports = { router, verifyAltcha };