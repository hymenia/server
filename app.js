const express = require('express');
const { useTls, webauthnRpID, webauthnOrigins } = require('./config');
const { authenticateToken } = require('./middleware/auth');

const { router: authRouter } = require('./routes/auth');
const accountRouter = require('./routes/account');
const { router: spacesRouter, inviteAcceptRouter } = require('./routes/spaces');
const { router: appsRouter, applicationsRouter } = require('./routes/apps');
const webhooksRouter = require('./routes/webhooks');
const { router: chatsRouter, getMessagesHandler } = require('./routes/chats');
const voiceRouter = require('./routes/voice');
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

app.use(express.json({ limit: '16kb' }));

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
    hcaptcha: {
      enabled: !!process.env.HCAPTCHA_SECRET,
      sitekey: process.env.HCAPTCHA_SITEKEY || null
    }
  });
});

app.use('/api/auth', authRouter);
app.use('/api', accountRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/invites', inviteAcceptRouter);
app.use('/api/apps', appsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api', webhooksRouter);
app.use('/api', chatsRouter);
app.use('/api/voice', voiceRouter);
app.use(liveKitValidateRouter);
app.get('/messages', authenticateToken, getMessagesHandler);

module.exports = app;
