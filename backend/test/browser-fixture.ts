// Manual browser QA helper: synthetic media only, served by a loopback tracker.
// Run from backend: node --import tsx test/browser-fixture.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import WebTorrent from 'webtorrent';
import { Server } from 'bittorrent-tracker';
import { config } from '../src/config/env.js';
const directory = resolve('../test-results/fixtures'); await mkdir(directory, { recursive: true });
const tracker = new Server({ udp: false, ws: false, http: true, stats: false });
tracker.listen(0, '127.0.0.1'); await once(tracker, 'listening');
const port = tracker.http!.address(); if (!port || typeof port === 'string') throw new Error('Tracker not listening');
const announce = [`http://127.0.0.1:${port.port}/announce`];
const client = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
const manifest = [];
for (const extension of ['mp4', 'mkv']) {
  const name = `Lumora test pattern.${extension}`; const path = join(directory, name);
  await promisify(execFile)(config.FFMPEG_PATH, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', extension === 'mkv' ? 'ac3' : 'aac', path]);
  const torrent = client.seed(path, { announce, private: true }); await once(torrent, 'seed');
  await writeFile(`${path}.torrent`, torrent.torrentFile);
  manifest.push({ name, infoHash: torrent.infoHash, torrentPath: `${path}.torrent`, magnet: torrent.magnetURI });
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { client.destroy(); tracker.close(); });
