import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from './config/env.js';
import { registerBrowserAccess } from './config/browserAccess.js';
import { connectRedis, redis } from './config/redis.js';
import { TorrentEngine } from './torrent/engine.js';
import { MediaService } from './stream/remuxer.js';
import { torrentRoutes } from './routes/torrentRoutes.js';
import { telemetryServer } from './realtime/telemetryServer.js';
import { resolveDhtBootstrap } from './torrent/discovery.js';

const app = Fastify({ logger: true, bodyLimit: 32768, requestTimeout: 120000 });
await registerBrowserAccess(app);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(i => i.message).join('; ') });
  const err = error as Error & { statusCode?: number };
  request.log.error(err);
  return reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : 'Unexpected server error' });
});
const engine = new TorrentEngine({ dht: { bootstrap: await resolveDhtBootstrap() } }); const media = new MediaService(engine);
await media.listen(); await connectRedis();
await torrentRoutes(app, engine, media);
const closeTelemetry = telemetryServer(app.server, engine);
app.get('/api/health', async () => ({ status: 'ok', redis: redis?.status ?? 'disabled', activeTorrents: engine.sessions.size,
  version: '1.2.0', uptimeSeconds: Math.floor(process.uptime()), persistence: 'local-disk', mediaProcesses: media.activeProcesses,
  mediaMetrics: media.metrics, discovery: engine.discoveryState, uploadLimitBytes: config.UPLOAD_LIMIT_BYTES }));
app.addHook('onClose', async () => { closeTelemetry(); await media.close(); await engine.destroy(); redis?.disconnect(); });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  // Stop long-lived streams before Fastify waits for open connections.
  closeTelemetry(); void media.close().then(() => { app.server.closeAllConnections(); return app.close(); });
});
await app.listen({ port: config.PORT, host: config.HOST });
void engine.restore().catch(error => app.log.warn(error));
