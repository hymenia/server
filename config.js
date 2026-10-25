const fs = require('fs');

const port = Number(process.env.PORT) || 9070;
const instanceName = (process.env.INSTANCE_NAME || 'Hymenia').trim().slice(0, 100) || 'Hymenia';

let publicUrl = null;
if (process.env.PUBLIC_URL) {
  let parsedPublicUrl;
  try {
    parsedPublicUrl = new URL(process.env.PUBLIC_URL);
  } catch {
    throw new Error('PUBLIC_URL must be a valid http or https origin');
  }
  if (!['http:', 'https:'].includes(parsedPublicUrl.protocol)
      || parsedPublicUrl.username
      || parsedPublicUrl.password
      || parsedPublicUrl.pathname !== '/'
      || parsedPublicUrl.search
      || parsedPublicUrl.hash) {
    throw new Error('PUBLIC_URL must be a valid http or https origin');
  }
  publicUrl = parsedPublicUrl.origin;
}

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  jwtSecret = 'dev-secret-change-me';
}

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
const useTls = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath);

const webauthnRpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const webauthnOrigins = (process.env.WEBAUTHN_ORIGIN
  || 'http://localhost:5173,tauri://localhost,http://tauri.localhost')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function webauthnRpIDForOrigin(origin) {
  if (origin === 'tauri://localhost') return 'localhost';
  if (origin === 'http://tauri.localhost') return 'tauri.localhost';
  return webauthnRpID;
}

const emailVerificationRequired = String(process.env.DISABLE_EMAIL_VERIFICATION || '')
  .trim()
  .toLowerCase() !== 'true';

module.exports = {
  port,
  instanceName,
  publicUrl,
  jwtSecret,
  certPath,
  keyPath,
  useTls,
  webauthnRpID,
  webauthnOrigins,
  webauthnRpIDForOrigin,
  emailVerificationRequired
};