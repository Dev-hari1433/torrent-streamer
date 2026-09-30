import { redis } from '../config/redis.js';

const TTL = 7 * 24 * 60 * 60;
const memory = new Map<string, Buffer>();
export const metadataCache = {
  async get(hash: string): Promise<Buffer | undefined> {
    if (memory.has(hash)) return memory.get(hash);
    const cached = await redis?.getBuffer(`torrent:meta:${hash}`).catch(() => null);
    return cached ?? memory.get(hash);
  },
  async put(hash: string, bytes: Uint8Array) {
    const buffer = Buffer.from(bytes);
    memory.set(hash, buffer);
    if (memory.size > 64) memory.delete(memory.keys().next().value!);
    await redis?.set(`torrent:meta:${hash}`, buffer, 'EX', TTL).catch(() => undefined);
  },
  async remember(hash: string) {
    await redis?.set(`torrent:session:${hash}`, hash, 'EX', TTL).catch(() => undefined);
  },
  async forget(hash: string, deleteMetadata = false) {
    if (deleteMetadata) memory.delete(hash);
    await redis?.del(`torrent:session:${hash}`, ...(deleteMetadata ? [`torrent:meta:${hash}`] : [])).catch(() => undefined);
  },
  async sessions(): Promise<string[]> {
    if (!redis || redis.status !== 'ready') return [];
    let cursor = '0'; const hashes: string[] = [];
    do {
      const result = await redis.scan(cursor, 'MATCH', 'torrent:session:*', 'COUNT', 100);
      cursor = result[0];
      hashes.push(...result[1].map(key => key.slice('torrent:session:'.length)));
    } while (cursor !== '0' && hashes.length < 100);
    return hashes.filter(hash => /^[a-f0-9]{40}$/.test(hash));
  },
};
