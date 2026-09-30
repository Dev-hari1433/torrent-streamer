import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SparseFileStore } from '../src/torrent/sparseStore.js';

test('sparse chunk store preserves data at 5/10/13 GiB without allocating intervening Windows disk space', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lumora-sparse-')); const path = join(folder, 'large.bin');
  const pieceLength = 1024 * 1024; const store = new SparseFileStore(pieceLength, { path, length: 14 * 1024 ** 3 });
  const put = (index: number, bytes: Uint8Array) => new Promise<void>((resolve, reject) => store.put(index, bytes, error => error ? reject(error) : resolve()));
  const get = (index: number) => new Promise<Uint8Array>((resolve, reject) => store.get(index, (error, bytes) => error ? reject(error) : resolve(bytes!)));
  try {
    await put(0, Buffer.alloc(pieceLength, 0x11));
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', '$file = Get-Item -LiteralPath $env:LUMORA_SPARSE_CHECK; [int]$file.Attributes'], { env: { ...process.env, LUMORA_SPARSE_CHECK: path } });
      assert.ok((Number(stdout.trim()) & 512) !== 0, 'must be marked sparse before any high-offset write');
    }
    for (const gib of [5, 10, 13]) {
      const data = Buffer.alloc(pieceLength, gib); const index = gib * 1024;
      await put(index, data); assert.deepEqual(Buffer.from(await get(index)), data);
    }
    assert.equal((await stat(path)).size, 13 * 1024 ** 3 + pieceLength);
    assert.deepEqual(Buffer.from(await get(0)), Buffer.alloc(pieceLength, 0x11));
  } finally {
    await new Promise<void>(resolve => store.close(() => resolve()));
    if (dirname(resolve(folder)) !== resolve(tmpdir())) throw Error('Unexpected test directory');
    await rm(folder, { recursive: true, force: true });
  }
});
