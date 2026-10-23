const express = require('express');
const WebSocket = require('ws');

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';

const PROXY_ROUTES = [
  { listenPath: '/livekit/rtc/v1', upstreamPath: '/rtc/v1' },
  { listenPath: '/livekit/rtc', upstreamPath: '/rtc' }
];

function upstreamUrl(route, query) {
  const base = LIVEKIT_URL.replace(/\/+$/, '');
  return query ? `${base}${route.upstreamPath}?${query}` : `${base}${route.upstreamPath}`;
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, String(reason || '').slice(0, 100));
  } catch (e) {
    try { ws.terminate(); } catch (_) { }
  }
}

function pipe(clientWs, req, route) {
  const query = (req.url || '').split('?')[1] || '';
  const upstream = new WebSocket(upstreamUrl(route, query));

  let upstreamOpen = false;
  let clientClosed = false;

  const teardown = () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      try { upstream.terminate(); } catch (_) { }
    }
  };

  upstream.on('open', () => {
    upstreamOpen = true;
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.send(data, { binary: isBinary }); } catch (e) { /* dropped */ }
    }
  });

  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      safeClose(clientWs, code || 1000, reason);
    } else if (clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.terminate();
    }
  });

  upstream.on('error', (err) => {
    console.error(`[livekit] ${route.listenPath} upstream connection failed:`, err.code || err.message);
    if (!upstreamOpen) {
      safeClose(clientWs, 1011, 'livekit unavailable');
    }
    teardown();
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.send(data, { binary: isBinary }); } catch (e) { }
    }
  });

  clientWs.on('close', () => {
    clientClosed = true;
    teardown();
  });

  clientWs.on('error', () => {
    if (!clientClosed) {
      clientClosed = true;
    }
    teardown();
  });
}

function attachLiveKitProxy() {
  return PROXY_ROUTES.map((route) => {
    const wss = new WebSocket.Server({
      noServer: true,
      path: route.listenPath,
      perMessageDeflate: false
    });

    wss.on('error', (err) => {
      console.error(`livekit proxy (${route.listenPath}) error:`, err.message);
    });

    wss.on('connection', (clientWs, req) => pipe(clientWs, req, route));

    return { path: route.listenPath, wss };
  });
}

const liveKitValidateRouter = express.Router();

for (const route of PROXY_ROUTES) {
  liveKitValidateRouter.get(`${route.listenPath}/validate`, async (req, res) => {
    try {
      const target = upstreamUrl(route, req.url.split('?')[1] || '');
      const upstream = await fetch(target.replace(/^ws/, 'http'));
      const body = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'text/plain').send(body);
    } catch (err) {
      res.status(502).send('livekit unavailable');
    }
  });
}

module.exports = { attachLiveKitProxy, liveKitValidateRouter };
