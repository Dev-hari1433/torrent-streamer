import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../src/stream/rangeHandler.js';
import { pieceRange, PieceSelector } from '../src/torrent/pieceSelector.js';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { Torrent, TorrentFile } from 'webtorrent';
import { normalizeMagnet, FALLBACK_TRACKERS } from '../src/torrent/engine.js';
import { classifyMedia, remuxArguments } from '../src/stream/remuxer.js';
import parseTorrent from 'parse-torrent';

test('range parser supports 13 GB files, suffixes, open ends, and RFC 416 cases', () => {
  const size = 13 * 1024 ** 3;
  assert.deepEqual(parseRange('bytes=10737418240-', size), { start: 10737418240, end: size - 1, partial: true });
  assert.deepEqual(parseRange('bytes=-16', size), { start: size - 16, end: size - 1, partial: true });
  assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9, partial: true });
  assert.deepEqual(parseRange(undefined, 10), { start: 0, end: 9, partial: false });
  for (const value of ['bytes=10-', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,2-3', 'items=0-1', 'bytes=9007199254740992-']) assert.equal(parseRange(value, 10), null);
});
test('piece mapping uses torrent-relative offsets and includes exact boundary pieces', () => {
  assert.deepEqual(pieceRange(150, 1000, 100, 0, 49), { start: 1, end: 1 });
  assert.deepEqual(pieceRange(150, 1000, 100, 50, 149), { start: 2, end: 2 });
  assert.deepEqual(pieceRange(150, 1000, 100, 999, 99999), { start: 11, end: 11 });
  assert.equal(pieceRange(0, 100, 10, 100, 110), null);
  assert.equal(pieceRange(0, 100, 10, -500, -1), null);
});
test('magnet normalization remains parseable, injects fallbacks and removes exact-source fetch URLs', async () => {
  const base = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
  const result = new URL(normalizeMagnet(`${base}&xs=http://127.0.0.1/private&ws=http://localhost/file`));
  assert.deepEqual(result.searchParams.getAll('tr'), FALLBACK_TRACKERS);
  assert.equal(result.searchParams.has('xs'), false); assert.equal(result.searchParams.has('ws'), false);
  assert.throws(() => normalizeMagnet('https://example.com/movie.torrent'));
  assert.throws(() => normalizeMagnet('magnet:?xt=urn:btih:invalid'));
  for (const magnet of [base, `${base}&tr=udp://a:1&tr=udp://b:2&tr=udp://c:3`, base.replaceAll(':btih:', '%3Abtih%3A')]) {
    assert.equal((await parseTorrent(normalizeMagnet(magnet))).infoHash, 'a'.repeat(40));
  }
  assert.equal((await parseTorrent(normalizeMagnet(`magnet:?xt=urn:btih:${'A'.repeat(32)}`))).infoHash, '0'.repeat(40));
});
test('codec inspection never mistakes an extension for browser compatibility', () => {
  const probe = { format: { duration: '120.5' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }] };
  assert.equal(classifyMedia('film.mp4', probe).mode, 'direct');
  assert.equal(classifyMedia('film.mkv', probe).mode, 'remux');
  const info = classifyMedia('film.mp4', { ...probe, streams: [probe.streams[0]!, { codec_type: 'audio', codec_name: 'ac3' }] });
  assert.equal(info.mode, 'remux');
  const args = remuxArguments('http://127.0.0.1/input', 1800, info);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy'); assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-ss') + 1], '1800'); assert.ok(args.includes('aresample=async=1:min_hard_comp=0.100000'));
  assert.throws(() => classifyMedia('film.avi', { streams: [{ codec_type: 'video', codec_name: 'mpeg4' }] }), /Unsupported source video codec/);
});

test('priority leases stay distinct and survive equal-bounds reader cleanup in the installed runtime', async () => {
  const require = createRequire(import.meta.url);
  const url = new URL('./lib/selections.js', pathToFileURL(require.resolve('webtorrent')));
  const { Selections } = await import(url.href);
  const selections = new Selections();
  const file = { name: 'small.mkv', offset: 0, length: 5 * 1024 ** 2, deselect() {} } as TorrentFile;
  const torrent = Object.assign(new EventEmitter(), { files: [file], pieceLength: 1024 ** 2, destroyed: false,
    _selections: selections, _updateSelections() {}, critical() {}, bitfield: { get: (index: number) => index < 2 } }) as unknown as Torrent;
  const selector = new PieceSelector(torrent, file);
  assert.deepEqual(selections._items.map((item: { priority: number }) => item.priority).sort((a: number, b: number) => a - b), [0, 3, 5, 15, 20]);
  selections.insert({ from: 0, to: 4, offset: 0, priority: 1, isStreamSelection: true });
  selections.remove({ from: 0, to: 4, isStreamSelection: true });
  assert.equal(selections._items.length, 5, 'closing a reader keeps all owned priorities');
  selector.updatePriorityWindow('read:test', 0, 0);
  assert.deepEqual(selections._items.map((item: { priority: number }) => item.priority).sort((a: number, b: number) => a - b), [0, 5, 10, 15, 20]);
  selector.release('read:test');
  assert.deepEqual(selections._items.map((item: { priority: number }) => item.priority), [20, 15, 5, 0], 'releasing the window preserves headers and background caching');
  selector.destroy(); assert.equal(selections._items.length, 0);
});
