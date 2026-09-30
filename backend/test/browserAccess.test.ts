import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { frontendOrigins, registerBrowserAccess } from '../src/config/browserAccess.js';
import { config } from '../src/config/env.js';
import { telemetryServer } from '../src/realtime/telemetryServer.js';
import type { TorrentEngine } from '../src/torrent/engine.js';

test('loopback aliases share CORS and WebSocket access; unrelated sites remain rejected', { timeout: 15000 }, async t => {
  const app = Fastify(); await registerBrowserAccess(app);
  app.get('/api/active', async () => []);
  const stopTelemetry = telemetryServer(app.server, { sessions: new Map() } as TorrentEngine);
  t.after(async () => { stopTelemetry(); await app.close(); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  for (const origin of frontendOrigins(config.FRONTEND_ORIGIN)) {
    const response = await app.inject({ url: '/api/active', headers: { host: '127.0.0.1:4000', origin } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['access-control-allow-origin'], origin);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/torrents/test', headers: {
      host: 'localhost:4000', origin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'content-type',
    } });
    assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin);
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/telemetry`, { origin });
    const [frame] = await once(ws, 'message'); assert.equal(JSON.parse(String(frame)).type, 'snapshot');
    ws.close(); await once(ws, 'close');
  }
  for (const origin of ['https://evil.example', 'null', 'http://localhost:9999', 'http://localhost.evil.example:3000']) {
    const response = await app.inject({ url: '/api/active', headers: { host: 'localhost:4000', origin } });
    assert.equal(response.statusCode, 403);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/telemetry`, { origin: 'https://evil.example' });
  await once(ws, 'error'); ws.terminate();
  assert.deepEqual(frontendOrigins('https://lumora.example'), ['https://lumora.example']);
});
