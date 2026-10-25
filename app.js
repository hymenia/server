const express = require('express');
const { useTls, webauthnRpID, webauthnOrigins } = require('./config');
const { authenticateToken } = require('./middleware/auth');

const { router: authRouter } = require('./routes/auth');
const { router: altchaRouter } = require('./routes/altcha');
const accountRouter = require('./routes/account');
const { router: spacesRouter, inviteAcceptRouter } = require('./routes/spaces');
const { router: appsRouter, applicationsRouter } = require('./routes/apps');
const webhooksRouter = require('./routes/webhooks');
const { router: chatsRouter, getMessagesHandler } = require('./routes/chats');
const voiceRouter = require('./routes/voice');
const instanceRouter = require('./routes/instance');
const adminRouter = require('./routes/admin');
const dmsRouter = require('./routes/dms');
const { liveKitValidateRouter } = require('./ws/voiceProxy');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name, X-File-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  res.header('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({
  limit: '1mb',
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tls: useTls,
    webauthn: {
      rpId: webauthnRpID,
      origins: webauthnOrigins
    },
    db: {
      configured: !!process.env.DATABASE_URL
    },
    altcha: {
      enabled: !!process.env.ALTCHA_HMAC_KEY
    }
  });
});

app.use(instanceRouter);
app.use('/api/admin', adminRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth', altchaRouter);
app.use('/api', accountRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/dms', dmsRouter);
app.use('/api/invites', inviteAcceptRouter);
app.use('/api/apps', appsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api', webhooksRouter);
app.use('/api', chatsRouter);
app.use('/api/voice', voiceRouter);
app.use(liveKitValidateRouter);
app.get('/messages', authenticateToken, getMessagesHandler);

module.exports = app;