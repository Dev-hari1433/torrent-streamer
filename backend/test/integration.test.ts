import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebTorrent from 'webtorrent';
import { TorrentEngine } from '../src/torrent/engine.js';
import { MediaService } from '../src/stream/remuxer.js';
import { serveRange } from '../src/stream/rangeHandler.js';
import { config } from '../src/config/env.js';
import { telemetryServer } from '../src/realtime/telemetryServer.js';
import { WebSocket } from 'ws';
import { downloadDirectory } from '../src/torrent/downloadStorage.js';
import { metadataCache } from '../src/torrent/metadataCache.js';

const execute = promisify(execFile);
const offline = { dht: false as const, tracker: false as const, lsd: false, natUpnp: false as const, natPmp: false, utp: false };
async function until(check: () => boolean, timeout = 15000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
}

test('real local swarm: ingestion, 206 bytes, telemetry, remux, video fidelity, seek and disconnect cleanup', { timeout: 90000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'lumora-test-'));
  const seeder = new WebTorrent(offline); const engine = new TorrentEngine(offline); const media = new MediaService(engine);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local'); const hash = url.searchParams.get('hash')!;
    try {
      if (url.pathname === '/remux') await media.stream(hash, Number(url.searchParams.get('start') ?? 0), await media.inspect(hash), res);
      else serveRange(req, res, engine.ready(hash));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  const stopTelemetry = telemetryServer(server, engine);
  t.after(async () => {
    stopTelemetry(); await media.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await engine.destroy(); await new Promise<void>(resolve => seeder.destroy(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  await media.listen(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await execute(config.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', join(folder, 'sample.mkv')]);
  const original = await readFile(join(folder, 'sample.mkv'));
  const seed = seeder.seed(join(folder, 'sample.mkv'), { announce: [] }); await once(seed, 'seed');
  const [session, duplicate] = await Promise.all([engine.add(Buffer.from(seed.torrentFile)), engine.add(Buffer.from(seed.torrentFile))]);
  assert.equal(session, duplicate); assert.equal(engine.sessions.size, 1);
  const seedAddress = seeder.address(); assert.ok(seedAddress && typeof seedAddress !== 'string');
  session.torrent.addPeer(`127.0.0.1:${seedAddress.port}`);
  await until(() => !!session.file);
  await until(() => session.file!.progress === 1);
  const rangeResponse = await fetch(`${origin}/raw?hash=${session.infoHash}`, { headers: { Range: 'bytes=111-999' } });
  assert.equal(rangeResponse.status, 206); assert.equal(rangeResponse.headers.get('content-range'), `bytes 111-999/${original.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), original.subarray(111, 1000));
  const single = await fetch(`${origin}/raw?hash=${session.infoHash}`, { headers: { Range: 'bytes=0-0' } });
  assert.deepEqual(Buffer.from(await single.arrayBuffer()), original.subarray(0, 1));
  const suffix = await fetch(`${origin}/raw?hash=${session.infoHash}`, { headers: { Range: 'bytes=-37' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), original.subarray(-37));
  const invalid = await fetch(`${origin}/raw?hash=${session.infoHash}`, { headers: { Range: `bytes=${original.length}-` } });
  assert.equal(invalid.status, 416);
  const head = await fetch(`${origin}/raw?hash=${session.infoHash}`, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(original.length));
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/telemetry`, { origin: config.FRONTEND_ORIGIN });
  const [message] = await once(ws, 'message'); const payload = JSON.parse(String(message));
  assert.equal(payload.torrents[0].infoHash, session.infoHash); ws.close();
  const info = await media.inspect(session.infoHash); assert.equal(info.mode, 'remux'); assert.equal(info.audioCodec, 'ac3');
  const remux = await fetch(`${origin}/remux?hash=${session.infoHash}`); assert.equal(remux.status, 200); assert.equal(remux.headers.get('accept-ranges'), 'none');
  const output = join(folder, 'remux.mp4'); await writeFile(output, Buffer.from(await remux.arrayBuffer()));
  const { stdout } = await execute(config.FFPROBE_PATH, ['-v', 'error', '-show_streams', '-of', 'json', output]);
  const streams = JSON.parse(stdout).streams as { codec_type: string; codec_name: string }[];
  assert.equal(streams.find(s => s.codec_type === 'video')?.codec_name, 'h264'); assert.equal(streams.find(s => s.codec_type === 'audio')?.codec_name, 'aac');
  // Compare encoded packet payload hashes, ignoring container timestamps.
  const packetHashes = async (path: string) => {
    const { stdout } = await execute(config.FFPROBE_PATH, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'csv=p=0', path]);
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  };
  assert.deepEqual(await packetHashes(output), await packetHashes(join(folder, 'sample.mkv')));
  const seekPoint = await media.seekPoint(session.infoHash, 4.5);
  assert.ok(seekPoint <= 4.5 && seekPoint > 3.5, 'A non-keyframe seek snaps to the preceding source keyframe');
  const seekProbeCount = media.metrics.seekProbes;
  assert.equal(await media.seekPoint(session.infoHash, 4.5), seekPoint);
  assert.equal(media.metrics.seekProbes, seekProbeCount, 'repeated seek lookup uses cache without launching FFprobe');
  assert.equal(media.metrics.seekCacheHits, 1);
  const cancelledSeek = new AbortController();
  const pendingSeek = media.seekPoint(session.infoHash, 2.7, cancelledSeek.signal);
  await until(() => media.activeProcesses > 0); cancelledSeek.abort();
  await assert.rejects(pendingSeek, { name: 'AbortError' });
  await until(() => media.activeProcesses === 0);
  const seekResponse = await fetch(`${origin}/remux?hash=${session.infoHash}&start=${seekPoint}`);
  const seekFile = join(folder, 'seek.mp4'); await writeFile(seekFile, Buffer.from(await seekResponse.arrayBuffer()));
  const seekProbe = await execute(config.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration:stream=start_time', '-of', 'json', seekFile]);
  const seekResult = JSON.parse(seekProbe.stdout);
  assert.ok(Math.abs(Number(seekResult.format.duration) - (info.duration - seekPoint)) < 0.15, 'Absolute seek timestamps avoid an extra GOP caused by negative container start times');
  const timestamps = seekResult.streams.map((s: { start_time: string }) => Number(s.start_time));
  assert.ok(Math.abs(timestamps[0] - timestamps[1]) < 0.15, 'A/V start timestamps remain aligned');
  const interrupted = await fetch(`${origin}/remux?hash=${session.infoHash}`);
  await interrupted.body?.cancel();
  await until(() => media.activeProcesses === 0);
  await until(() => session.readers === 0);
  // Verify owned priorities stay distinct on the installed runtime.
  session.selector!.updatePriorityWindow('test-viewer', 0, 0);
  const runtime = session.torrent as unknown as { _selections: { _items: { priority: number }[] } };
  assert.ok(runtime._selections._items.every(item => [0, 1, 3, 5, 10, 15, 20].includes(item.priority)));
  // Internal recovery explicitly retains cached data; the user-facing default deletes it.
  const download = downloadDirectory(config.DATA_DIR, session.torrent.name, session.infoHash)!;
  await engine.remove(session.infoHash, false); assert.equal(engine.sessions.size, 0); await access(download);
  const newTracker = 'http://127.0.0.1:12345/updated-announce';
  const restored = await engine.add(`magnet:?xt=urn:btih:${session.infoHash}&tr=${encodeURIComponent(newTracker)}`);
  await until(() => !!restored.file);
  assert.ok(restored.torrent.announce.includes(newTracker), 'cached public metadata preserves newly supplied magnet trackers');
  await new Promise<void>(resolve => restored.torrent.destroy(() => resolve()));
  await engine.remove(restored.infoHash);
  await assert.rejects(access(download), { code: 'ENOENT' });
  await assert.rejects(access(join(config.DATA_DIR, '.lumora-sessions', `${restored.infoHash}.json`)), { code: 'ENOENT' });
  assert.equal(await metadataCache.get(restored.infoHash), undefined, 'user removal also forgets cached metadata');
});
