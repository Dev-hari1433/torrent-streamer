import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import Fastify from 'fastify';
import type { Torrent, TorrentFile } from 'webtorrent';
import { PieceSelector } from '../src/torrent/pieceSelector.js';
import { waitForInitialBuffer, INITIAL_BUFFER_TIMEOUT_MS } from '../src/stream/initialBuffer.js';
import { TorrentEngine, type TorrentSession } from '../src/torrent/engine.js';
import { MediaService, classifyMedia } from '../src/stream/remuxer.js';
import { torrentRoutes } from '../src/routes/torrentRoutes.js';

function stalledTorrent(offset = 0, length = 10 * 1024 ** 2) {
  const verified = new Set<number>(); const critical: number[][] = [];
  const file = { name: 'stalled.mkv', length, offset, progress: 0, deselect() {} } as TorrentFile;
  const torrent = Object.assign(new EventEmitter(), {
    files: [file], pieceLength: 1024 ** 2, destroyed: false, downloadSpeed: 2, uploadSpeed: 0, numPeers: 2,
    _selections: { _items: [] }, _updateSelections() {},
    critical(start: number, end: number) { critical.push([start, end]); },
    bitfield: { get: (index: number) => verified.has(index) },
  }) as unknown as Torrent;
  const selector = new PieceSelector(torrent, file);
  return { torrent, file, selector, critical, verify(index: number) { verified.add(index); torrent.emit('verified', index); } };
}

test('header readiness requires every overlapping verified piece, including a nonzero video offset', async () => {
  const fixture = stalledTorrent(1.5 * 1024 ** 2);
  assert.ok(fixture.critical.some(([start, end]) => start === 1 && end === 1), 'the video header piece is immediately critical');
  assert.equal(fixture.selector.initialBufferTargetBytes, 2 * 1024 ** 2);
  let ready = false;
  const wait = waitForInitialBuffer(fixture.selector).then(() => { ready = true; });
  fixture.verify(0); fixture.verify(1); fixture.verify(3);
  await Promise.resolve(); assert.equal(ready, false, 'a gap cannot be mistaken for a playable buffer');
  fixture.verify(2); await wait;
  assert.equal(fixture.selector.initialBufferReady, true);
  assert.equal(fixture.selector.listenerCount('initialBufferReady'), 0);
  fixture.selector.destroy(); assert.equal(fixture.torrent.listenerCount('verified'), 0);
});

test('already available short files bypass waiting; abort and removal release pending listeners', async () => {
  const small = stalledTorrent(0, 500);
  assert.equal(small.selector.initialBufferTargetBytes, 500);
  small.verify(0); await waitForInitialBuffer(small.selector); small.selector.destroy();
  const fixture = stalledTorrent(); const controller = new AbortController();
  const aborted = waitForInitialBuffer(fixture.selector, { signal: controller.signal });
  controller.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(fixture.selector.listenerCount('initialBufferReady'), 0);
  const removed = waitForInitialBuffer(fixture.selector);
  fixture.selector.destroy(); await assert.rejects(removed, { statusCode: 503, message: 'Buffering initial chunks' });
  assert.equal(fixture.selector.listenerCount('closed'), 0);
});

test('0% MKV stream and inspection wait 30 seconds, then return HTTP 503 without spawning media processes', { timeout: 40000 }, async t => {
  const fixture = stalledTorrent(); const hash = 'a'.repeat(40);
  const session: TorrentSession = { infoHash: hash, name: fixture.file.name, file: fixture.file,
    torrent: fixture.torrent, selector: fixture.selector, readers: 0, addedAt: Date.now() };
  const engine = Object.assign(Object.create(TorrentEngine.prototype) as TorrentEngine, { sessions: new Map([[hash, session]]) });
  const media = new MediaService(engine); const app = Fastify();
  await torrentRoutes(app, engine, media);
  app.get('/api/health', async () => ({ status: 'ok' }));
  t.after(async () => { fixture.selector.destroy(); await app.close(); await media.close(); });
  const started = Date.now();
  const stream = app.inject(`/api/stream/${hash}`); const inspection = app.inject(`/api/media/${hash}`);
  // Direct MediaService callers must receive the same protection as HTTP routes.
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  const info = classifyMedia('stalled.mkv', { streams: [{ codec_type: 'video', codec_name: 'h264' }] });
  const remux = assert.rejects(media.stream(hash, 0, info, response), { statusCode: 503, message: 'Buffering initial chunks' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(media.activeProcesses, 0); assert.equal(fixture.selector.initialBufferReady, false);
  const [streamResult, inspectionResult] = await Promise.all([stream, inspection, remux]);
  for (const result of [streamResult, inspectionResult]) {
    assert.equal(result.statusCode, 503); assert.equal(result.headers['retry-after'], '3');
    assert.equal(result.json().error, 'Buffering initial chunks');
    assert.equal(result.json().code, 'INITIAL_BUFFER_PENDING');
  }
  assert.ok(Date.now() - started >= INITIAL_BUFFER_TIMEOUT_MS - 100);
  assert.equal(media.activeProcesses, 0); assert.equal(fixture.selector.listenerCount('initialBufferReady'), 0);
  assert.equal((await app.inject('/api/health')).json().status, 'ok', 'the server remains responsive after the buffering timeout');
  const snapshot = engine.snapshot(session); assert.equal(snapshot.initialBufferReady, false); assert.equal(snapshot.initialBufferBytes, 0);
});
