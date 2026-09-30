// Repeatable cold-swarm benchmark, outside the unit suite. No public media.
// Run: node --import tsx test/benchmark.ts
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import WebTorrent from 'webtorrent';
import { config } from '../src/config/env.js';
import { TorrentEngine } from '../src/torrent/engine.js';
import { MediaService } from '../src/stream/remuxer.js';
const offline = { dht: false as const, tracker: false as const, lsd: false, natUpnp: false as const, natPmp: false, utp: false };
const folder = await mkdtemp(join(tmpdir(), 'lumora-benchmark-'));
const seeder = new WebTorrent({ ...offline, uploadLimit: 1024 * 1024 });
const engine = new TorrentEngine(offline); const media = new MediaService(engine);
const server = createServer(async (_req, res) => {
  try { await media.stream(hash, 0, await media.inspect(hash), res); }
  catch (error) { res.destroy(error as Error); }
});
let hash = ''; const start = performance.now();
try {
  const file = join(folder, 'long-gop.mkv');
  await promisify(execFile)(config.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-b:v', '6M', '-minrate', '6M', '-maxrate', '6M', '-bufsize', '6M', '-x264-params', 'nal-hrd=cbr:force-cfr=1', file]);
  const seed = seeder.seed(file, { announce: [] }); await once(seed, 'seed');
  const began = performance.now(); const session = await engine.add(Buffer.from(seed.torrentFile)); hash = session.infoHash;
  const ingestMs = performance.now() - began;
  const address = seeder.address(); if (!address || typeof address === 'string') throw Error('No seeder');
  if (!session.torrent.infoHash) await once(session.torrent, 'infoHash');
  session.torrent.addPeer(`127.0.0.1:${address.port}`);
  if (!session.file) await once(session.torrent, 'ready');
  if (!session.selector!.initialBufferReady) await once(session.selector!, 'initialBufferReady');
  const headerMs = performance.now() - began;
  await media.listen(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const httpAddress = server.address(); if (!httpAddress || typeof httpAddress === 'string') throw Error('No server');
  const playbackStart = performance.now(); const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${httpAddress.port}`, { signal: controller.signal });
  const reader = response.body!.getReader(); let received = Buffer.alloc(0); let firstByteMs = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) throw Error('No media fragment received');
    if (!firstByteMs) firstByteMs = performance.now() - playbackStart;
    received = Buffer.concat([received.subarray(-16), Buffer.from(value)]);
    if (received.includes(Buffer.from('moof'))) break;
  }
  const result = { label: process.env.BENCHMARK_LABEL ?? 'current', uploadLimit: 1048576, gopSeconds: 10,
    ingestMs: Math.round(ingestMs), headerMs: Math.round(headerMs), firstByteMs: Math.round(firstByteMs),
    firstMediaFragmentMs: Math.round(performance.now() - playbackStart), endToEndFragmentMs: Math.round(performance.now() - began),
    downloadedPercent: Number((session.file!.progress * 100).toFixed(1)), elapsedMs: Math.round(performance.now() - start) };
  controller.abort(); await reader.cancel().catch(() => undefined);
  await mkdir(resolve('../test-results'), { recursive: true });
  await writeFile(resolve(`../test-results/benchmark-${result.label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await media.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (hash) await engine.remove(hash); await engine.destroy();
  await new Promise<void>(resolve => seeder.destroy(() => resolve())); await rm(folder, { recursive: true, force: true });
}
