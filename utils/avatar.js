const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function validateAvatarDataUrl(avatarUrl) {
  if (typeof avatarUrl !== 'string') return 'an image is required';
  const match = avatarUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return 'unsupported image format';
  const approxBytes = (match[2].length * 3) / 4;
  if (approxBytes > 500 * 1024) return 'image must be smaller than 500kb';
  return null;
}

const defaultAvatarPath = process.env.DEFAULT_AVATAR_PATH || path.join(__dirname, '..', 'assets', 'default-avatar.png');
let defaultAvatarBuffer;
let defaultAvatarMime;
let defaultAvatarEtag;

function loadDefaultAvatar() {
  if (!fs.existsSync(defaultAvatarPath)) {
    console.warn('[avatar] default avatar not found at %s', defaultAvatarPath);
    return;
  }

  defaultAvatarBuffer = fs.readFileSync(defaultAvatarPath);
  defaultAvatarMime = defaultAvatarPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  console.log('[avatar] loaded default avatar from %s (%d bytes)', defaultAvatarPath, defaultAvatarBuffer.length);
  defaultAvatarEtag = crypto.createHash('md5').update(defaultAvatarBuffer).digest('hex');
}


loadDefaultAvatar();

function getDefaultAvatar() {
  return { buffer: defaultAvatarBuffer, mime: defaultAvatarMime, etag: defaultAvatarEtag };
}

module.exports = { validateAvatarDataUrl, getDefaultAvatar };
