import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// Match the pinned WebTorrent/fs-chunk-store addUID directory. Never remove a
// caller-supplied path, the shared data root, or a directory outside that root.
export function downloadDirectory(root: string, name: string | undefined, hash: string): string | undefined {
  if (!name) return undefined; // Metadata has not arrived; no store exists yet.
  if (!/^[a-f0-9]{40}$/.test(hash) || name !== basename(name) || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Unsafe torrent storage name');
  const directory = resolve(root, `${name} - ${hash.slice(0, 8)}`);
  if (dirname(directory) !== resolve(root)) throw new Error('Torrent storage is outside the data directory');
  return directory;
}
export async function eraseDownload(root: string, directory?: string) {
  if (!directory) return;
  if (dirname(resolve(directory)) !== resolve(root)) throw new Error('Refusing to erase outside torrent storage');
  const entry = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new Error('Refusing to erase a linked torrent directory');
  const actualRoot = await realpath(root); const actualDirectory = await realpath(directory);
  if (dirname(actualDirectory) !== actualRoot || actualDirectory !== join(actualRoot, basename(directory))) throw new Error('Torrent storage path changed');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
