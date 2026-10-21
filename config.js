const fs = require('fs');

const port = Number(process.env.PORT) || 9070;

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

module.exports = {
  port,
  jwtSecret,
  certPath,
  keyPath,
  useTls,
  webauthnRpID,
  webauthnOrigins,
  webauthnRpIDForOrigin
};
