import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pipeline, Readable } from 'node:stream';
import type { TorrentSession } from '../torrent/engine.js';

export function parseRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number; let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}

export function serveRange(req: IncomingMessage, res: ServerResponse, session: TorrentSession, mime = 'video/mp4') {
  const file = session.file!;
  const range = parseRange(req.headers.range, file.length);
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'no-store');
  if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return; }
  const { start, end, partial } = range;
  res.statusCode = partial ? 206 : 200;
  res.setHeader('Content-Type', mime); res.setHeader('Content-Length', end - start + 1);
  if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
  if (req.method === 'HEAD') { res.end(); return; }
  const owner = `read:${randomUUID()}`;
  let offset = start; let last = 0; let closed = false;
  session.selector?.updatePriorityWindow(owner, offset);
  session.readers++;
  let current: Readable | undefined;
  // Long WebTorrent reads select all pieces to EOF. Bound each source read so
  // torrent selection stays near the bytes actually consumed by the client.
  const source = Readable.from((async function* () {
    for (let cursor = start; cursor <= end && !closed; cursor += 4 * 1024 * 1024) {
      const chunkEnd = Math.min(end, cursor + 4 * 1024 * 1024 - 1);
      // WebTorrent treats end=0 as an absent bound. Read at most two bytes and
      // trim the iterator for a bytes=0-0 request.
      current = file.createReadStream({ start: cursor, end: Math.max(1, chunkEnd) });
      let remaining = chunkEnd - cursor + 1;
      try { for await (const chunk of current) {
        const bytes = Buffer.from(chunk as Uint8Array);
        yield bytes.subarray(0, remaining); remaining -= Math.min(remaining, bytes.length);
        if (!remaining) break;
      } }
      finally { current.destroy(); }
    }
  })());
  const cleanup = () => {
    if (closed) return; closed = true;
    current?.destroy(); source.destroy(); session.readers = Math.max(0, session.readers - 1); session.selector?.release(owner);
  };
  res.once('close', cleanup); req.once('aborted', cleanup);
  source.on('data', (chunk: Buffer) => {
    offset += chunk.length;
    if (Date.now() - last > 1000) { session.selector?.updatePriorityWindow(owner, offset); last = Date.now(); }
  });
  pipeline(source, res, () => { cleanup(); req.removeListener('aborted', cleanup); res.removeListener('close', cleanup); });
}
