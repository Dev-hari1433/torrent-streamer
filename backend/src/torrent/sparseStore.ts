import FileStore from 'fs-chunk-store';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

let markSparse: ((fd: number) => Promise<void>) | undefined;
if (process.platform === 'win32') {
  try { markSparse = (createRequire(import.meta.url)('fs-native-extensions') as { sparse(fd: number): Promise<void> }).sparse; }
  catch { console.warn('Sparse file support is unavailable; large seeks may allocate additional disk space.'); }
}

/** Preserve fs-chunk-store semantics, but mark Windows files before any out-of-order write. */
export class SparseFileStore extends FileStore {
  constructor(chunkLength: number, options: Record<string, unknown>) {
    super(chunkLength, options);
    if (!markSparse) return;
    // This narrow adapter targets the pinned fs-chunk-store 5.0.1 file-open callback.
    for (const file of this.files) {
      const originalOpen = file.open;
      let prepared: Promise<void> | undefined;
      file.open = callback => {
        prepared ??= (async () => {
          await mkdir(dirname(file.path), { recursive: true });
          const handle = await open(file.path, 'a+');
          try { await markSparse!(handle.fd); } finally { await handle.close(); }
        })();
        void prepared.then(() => originalOpen(callback), error => callback(error));
      };
    }
  }
}
