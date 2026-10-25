const fs = require('fs');
const http = require('http');
const https = require('https');

const app = require('./app');
const { ensureDb, pool } = require('./db');
const { attachAllWebSockets } = require('./ws');
const {
  port,
  certPath,
  keyPath,
  useTls,
  webauthnRpID,
  webauthnOrigins,
  emailVerificationRequired
} = require('./config');

const server = useTls
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);

attachAllWebSockets(server);

// when email verification is disabled, everyone is verified
async function autoVerifyUsers() {
  if (emailVerificationRequired) return;
  try {
    const r = await pool.query(
      'update users set email_verified_at = now() where email_verified_at is null'
    );
    if (r.rowCount) console.log(`auto-verified ${r.rowCount} user(s)`);
  } catch (e) {
    console.error('failed to auto-verify users', e);
  }
}

async function start() {
  await ensureDb();
  await autoVerifyUsers();

  const protocol = useTls ? 'https' : 'http';
  console.log('');
  console.log('========================================');
  console.log('  Hymenia server config summary');
  console.log('========================================');
  console.log('  PORT / protocol :', port, '/', protocol);
  console.log('  TLS certs loaded:', useTls ? `yes (${certPath})` : 'no (plain HTTP)');
  console.log('  DATABASE_URL    :', process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:([^:@/]+)@/, ':***@') : 'Using fallback');
  console.log('  JWT_SECRET set  :', !!process.env.JWT_SECRET ? 'yes' : 'NO (using dev fallback, UNSAFE in prod!)');
  console.log('  EMAIL VERIFY    :', emailVerificationRequired ? 'required' : 'disabled');
  console.log('  WEBAUTHN RP/ORIG:', webauthnRpID, '/', webauthnOrigins);
  if (webauthnOrigins.includes('http://localhost:5173') && process.env.NODE_ENV === 'production') {
    console.log('  !!!! WARNING: WEBAUTHN_ORIGIN is default localhost value (not set). Passkeys on production domains will break.');
  }
  console.log('========================================');
  console.log('');

  server.listen(port, '0.0.0.0', () => {
    console.log(`Hymenia server listening on ${protocol}://0.0.0.0:${port}`);
  });
}

start();