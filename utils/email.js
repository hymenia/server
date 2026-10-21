const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let disposableDomains = null;

function loadDisposableDomains() {
  if (disposableDomains) return disposableDomains;
  const filePath = path.join(__dirname, 'disposable_domains.txt');
  const contents = fs.readFileSync(filePath, 'utf8');
  disposableDomains = new Set(
    contents
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'))
  );
  return disposableDomains;
}

function isDisposableEmail(email) {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1).trim().toLowerCase();
  if (!domain) return false;

  const domains = loadDisposableDomains();
  if (domains.has(domain)) return true;

  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (domains.has(parentDomain)) return true;
  }
  return false;
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashVerificationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sendVerificationEmail(email, token, origin) {
  const verifyUrl = `${origin}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = 'Verify your email address';
  const html = `
    <h1>Welcome to Hymenia!</h1>
    <p>Click the link below to verify your email address:</p>
    <p><a href="${verifyUrl}">${verifyUrl}</a></p>
    <p>This link expires in 24 hours.</p>
  `;
  const text = `Verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`;

  if (!process.env.SMTP_HOST) {
    console.warn('[email] SMTP not configured, would send to:', email);
    return true;
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      } : undefined
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@hymenia.local',
      to: email,
      subject,
      html,
      text
    });
    return true;
  } catch (e) {
    console.error('[email] failed to send verification email:', e.message);
    return false;
  }
}

module.exports = {
  generateVerificationToken,
  hashVerificationToken,
  sendVerificationEmail,
  isDisposableEmail
};
