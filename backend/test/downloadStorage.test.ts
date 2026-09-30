import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadDirectory, eraseDownload } from '../src/torrent/downloadStorage.js';

test('download deletion is isolated, idempotent, and rejects unsafe paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lumora-delete-')); t.after(() => rm(root, { recursive: true, force: true }));
  const hash = 'a'.repeat(40); const target = downloadDirectory(root, 'Selected movie', hash)!;
  const neighbor = downloadDirectory(root, 'Keep this movie', 'b'.repeat(40))!;
  await mkdir(target); await mkdir(neighbor); await writeFile(join(target, 'movie.mkv'), 'downloaded pieces');
  await writeFile(join(neighbor, 'movie.mkv'), 'other user data');
  await eraseDownload(root, target);
  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(join(neighbor, 'movie.mkv'), 'utf8'), 'other user data');
  await eraseDownload(root, target);
  assert.equal(downloadDirectory(root, undefined, hash), undefined);
  for (const name of ['..', '../outside', '..\\outside', 'nested/file', 'nested\\file']) assert.throws(() => downloadDirectory(root, name, hash));
  await assert.rejects(eraseDownload(root, root));
  await assert.rejects(eraseDownload(root, join(root, '..', 'outside')));
});
