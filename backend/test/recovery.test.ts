import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/torrent/sessionStore.js';
import { swarmDiagnostics } from '../src/torrent/diagnostics.js';
import type { TorrentSession } from '../src/torrent/engine.js';

test('disk session records survive a fresh store, replace magnets with metadata, and remove durably', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lumora-sessions-')); const hash = 'b'.repeat(40);
  try {
    const store = new SessionStore(folder); const magnet = `magnet:?xt=urn:btih:${hash}`;
    await store.save(hash, magnet); assert.equal((await new SessionStore(folder).load())[0]?.source, magnet);
    await store.save(hash, Buffer.from('metadata'));
    assert.deepEqual((await new SessionStore(folder).load())[0]?.source, Buffer.from('metadata'));
    await writeFile(join(folder, `${'c'.repeat(40)}.json`), 'corrupt');
    assert.equal((await store.load()).length, 1);
    await store.remove(hash); assert.equal((await new SessionStore(folder).load()).length, 0);
    await assert.rejects(store.save('../escape', 'invalid'), /Invalid session hash/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('diagnostics distinguish absent peers, unavailable pieces, upload choking, and a ready buffer', () => {
  const session = { addedAt: 1000, file: { progress: 0 }, selector: { firstMissingInitialPiece: 0, initialBufferReady: false }, torrent: { wires: [] } } as unknown as TorrentSession;
  assert.equal(swarmDiagnostics(session, 31000).phase, 'no-peers');
  const wire = { peerChoking: true, peerPieces: { get: () => false }, downloadSpeed: () => 0 };
  (session.torrent as any).wires = [wire];
  assert.equal(swarmDiagnostics(session, 31000).phase, 'missing-pieces');
  wire.peerPieces.get = () => true; assert.equal(swarmDiagnostics(session, 31000).phase, 'choked');
  wire.peerChoking = false; assert.equal(swarmDiagnostics(session, 31000).phase, 'stalled');
  (session.selector as any).initialBufferReady = true; assert.equal(swarmDiagnostics(session, 31000).phase, 'ready');
});
