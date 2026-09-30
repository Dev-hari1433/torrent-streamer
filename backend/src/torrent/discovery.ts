import { lookup } from 'node:dns/promises';

export const DHT_ROUTERS = ['router.bittorrent.com', 'router.utorrent.com', 'dht.transmissionbt.com'];
type Resolver = (host: string, options: { family: 4; all: true }) => Promise<{ address: string }[]>;

// k-rpc-socket resolves hostnames without specifying a family, then sends on
// udp4. On IPv6-first systems this silently loses a dual-stack bootstrap router.
// Resolve all IPv4 addresses explicitly; do not change machine-wide DNS settings.
export async function resolveDhtBootstrap(resolve: Resolver = lookup, timeoutMs = 2000) {
  const groups = await Promise.all(DHT_ROUTERS.map(async host => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        resolve(host, { family: 4, all: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs); }),
      ]);
      return addresses.map(({ address }) => `${address}:6881`);
    } catch { return [host + ':6881']; }
    finally { clearTimeout(timer); }
  }));
  return [...new Set(groups.flat())];
}

export function shouldRecoverDiscovery(session: {
  addedAt: number; lastDataAt?: number; lastRefreshAt?: number; recoveryAttempts?: number;
  error?: string; torrent: { destroyed: boolean }; file?: { progress: number };
}, now: number) {
  if (session.error || session.torrent.destroyed || session.file?.progress === 1) return false;
  const delay = Math.min(300000, 20000 * 2 ** Math.min(session.recoveryAttempts ?? 0, 4));
  return now - (session.lastDataAt ?? session.addedAt) >= delay
    && now - (session.lastRefreshAt ?? session.addedAt) >= Math.max(30000, delay);
}
