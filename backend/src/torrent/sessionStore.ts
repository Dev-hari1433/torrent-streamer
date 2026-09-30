import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';

// Local restart recovery needs no hosted service. Each session has its own
// atomic record; downloaded media remains in WebTorrent's existing disk store.
export class SessionStore {
  constructor(private directory: string) {}
  private path(hash: string) {
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid session hash');
    return join(this.directory, `${hash}.json`);
  }
  async save(hash: string, source: string | Uint8Array) {
    const path = this.path(hash);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(typeof source === 'string' ? { magnet: source } : { torrent: Buffer.from(source).toString('base64') }));
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(hash: string) { await rm(this.path(hash), { force: true }); }
  async load(): Promise<Array<{ hash: string; source: string | Buffer }>> {
    const records = [];
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as { magnet?: string; torrent?: string };
        const source = record.torrent ? Buffer.from(record.torrent, 'base64') : record.magnet;
        if (source) records.push({ hash: name.slice(0, 40), source });
      } catch { console.warn(`Ignoring unreadable saved torrent ${name.slice(0, 8)}`); }
    }
    return records;
  }
}
export const sessionStore = new SessionStore(join(config.DATA_DIR, '.lumora-sessions'));
