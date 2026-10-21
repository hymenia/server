const crypto = require('crypto');

function generateAppToken() {
  const raw = crypto.randomBytes(64).toString('hex');
  return `hm.app.${raw}`;
}

function generateWebhookToken() {
  const raw = crypto.randomBytes(64).toString('hex');
  return `hm.hook.${raw}`;
}

function hashAppToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateInviteCode() {
  return crypto.randomBytes(9).toString('base64url');
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function issueToken(user, jwtSecret) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: '7d' });
}

module.exports = {
  generateAppToken,
  generateWebhookToken,
  hashAppToken,
  generateInviteCode,
  normalizeUsername,
  issueToken
};
