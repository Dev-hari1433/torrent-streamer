import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TorrentEngine } from '../torrent/engine.js';
import type { MediaService } from '../stream/remuxer.js';
import { PLAYBACK_QUALITIES, availableQualities } from '../stream/remuxer.js';
import { serveRange } from '../stream/rangeHandler.js';
import { userDatabase } from '../config/supabase.js';

async function cancellable<T>(request: FastifyRequest, reply: FastifyReply, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once('aborted', abort); reply.raw.once('close', abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try { return await run(controller.signal); }
  catch (error) {
    if (controller.signal.aborted) return;
    if ((error as { code?: string }).code === 'INITIAL_BUFFER_PENDING') {
      reply.header('Retry-After', '3').code(503).send({ error: 'Buffering initial chunks', code: 'INITIAL_BUFFER_PENDING', retryAfterMs: 3000 });
      return;
    }
    throw error;
  } finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
}

const hashParams = z.object({ infoHash: z.string().regex(/^[a-f0-9]{40}$/) });
export async function torrentRoutes(app: FastifyInstance, engine: TorrentEngine, media: MediaService) {
  app.post('/api/magnet', { bodyLimit: 32768 }, async (request, reply) => {
    const { magnet } = z.object({ magnet: z.string().max(16384) }).parse(request.body);
    const session = await engine.add(magnet);
    return reply.code(202).send(engine.snapshot(session));
  });
  app.post('/api/upload', async (request, reply) => {
    const file = await request.file();
    if (!file || !/\.torrent$/i.test(file.filename)) return reply.code(400).send({ error: 'Choose a .torrent file' });
    const bytes = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'Torrent metadata must be under 50 MB' });
    const session = await engine.add(bytes);
    return reply.code(202).send(engine.snapshot(session));
  });
  app.get('/api/active', async () => [...engine.sessions.values()].map(session => engine.snapshot(session)));
  app.get('/api/torrents/:infoHash', async request => engine.snapshot(engine.get(hashParams.parse(request.params).infoHash)));
  app.delete('/api/torrents/:infoHash', async request => {
    const { infoHash } = hashParams.parse(request.params); media.forget(infoHash); await engine.remove(infoHash); return { removed: true, dataDeleted: true };
  });
  app.post('/api/torrents/:infoHash/refresh', async request => engine.refresh(hashParams.parse(request.params).infoHash));
  app.get('/api/media/:infoHash', async (request, reply) => cancellable(request, reply, signal => media.inspect(hashParams.parse(request.params).infoHash, signal)));
  app.get('/api/media/:infoHash/seek', async (request, reply) => cancellable(request, reply, async signal => {
    const { infoHash } = hashParams.parse(request.params);
    const { time } = z.object({ time: z.coerce.number().finite().min(0) }).parse(request.query);
    return { start: await media.seekPoint(infoHash, time, signal) };
  }));
  app.post('/api/torrents/:infoHash/playhead', async request => {
    const { infoHash } = hashParams.parse(request.params);
    const body = z.object({ sessionId: z.string().uuid(), byteOffset: z.number().int().nonnegative().safe(), bufferedSeconds: z.number().min(0).max(86400) }).parse(request.body);
    const session = engine.ready(infoHash);
    session.selector.updatePriorityWindow(`player:${body.sessionId}`, body.byteOffset, body.bufferedSeconds);
    return { bufferedBytes: session.selector.bufferedBytes(body.byteOffset) };
  });
  app.delete('/api/torrents/:infoHash/playhead/:sessionId', async request => {
    const { infoHash, sessionId } = z.object({ infoHash: z.string().regex(/^[a-f0-9]{40}$/), sessionId: z.string().uuid() }).parse(request.params);
    engine.ready(infoHash).selector.release(`player:${sessionId}`); return { released: true };
  });
  app.get('/api/stream/:infoHash', async (request, reply) => cancellable(request, reply, async signal => {
    const { infoHash } = hashParams.parse(request.params);
    const { start, quality } = z.object({ start: z.coerce.number().finite().min(0).default(0), quality: z.enum(PLAYBACK_QUALITIES).default('original') }).parse(request.query);
    const session = engine.ready(infoHash); const info = await media.inspect(infoHash, signal);
    if (request.raw.destroyed || reply.raw.destroyed) return;
    if (info.duration && start >= info.duration) return reply.code(416).send({ error: 'Seek exceeds media duration' });
    if (!availableQualities(info.height).includes(quality)) return reply.code(400).send({ error: 'This quality is unavailable for the source resolution' });
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value);
    if (info.mode === 'direct' && quality === 'original') { reply.hijack(); serveRange(request.raw, reply.raw, session); }
    else {
      if (request.method === 'HEAD') return reply.header('Content-Type', 'video/mp4').header('Accept-Ranges', 'none').send();
      // Remux bytes are a new representation and cannot honor source byte ranges.
      if (request.headers.range && request.headers.range !== 'bytes=0-') return reply.code(416).header('Accept-Ranges', 'none').send();
      await media.stream(infoHash, start, info, reply.raw, signal, quality); reply.hijack();
    }
  }));
  app.get('/api/library', async request => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw Object.assign(new Error('Sign in to view your library'), { statusCode: 401 });
    const db = userDatabase(token); const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user) throw Object.assign(new Error('Session expired'), { statusCode: 401 });
    const result = await db.from('watch_history').select('*').order('updated_at', { ascending: false }).limit(100);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  });
  app.put('/api/library/:infoHash', async request => {
    const { infoHash } = hashParams.parse(request.params);
    const body = z.object({ name: z.string().min(1).max(500), position: z.number().min(0).max(1e8), duration: z.number().min(0).max(1e8), bookmarked: z.boolean().optional() }).parse(request.body);
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw Object.assign(new Error('Sign in to save your library'), { statusCode: 401 });
    const db = userDatabase(token); const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user) throw Object.assign(new Error('Session expired'), { statusCode: 401 });
    const result = await db.from('watch_history').upsert({ user_id: auth.user.id, info_hash: infoHash, ...body, updated_at: new Date().toISOString() }, { onConflict: 'user_id,info_hash' });
    if (result.error) throw new Error(result.error.message);
    return { saved: true };
  });
}
