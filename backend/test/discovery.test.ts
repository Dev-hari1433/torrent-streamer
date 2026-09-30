import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDhtBootstrap, shouldRecoverDiscovery, DHT_ROUTERS } from '../src/torrent/discovery.js';

test('DHT bootstrap explicitly resolves IPv4, retains alternate A records, and bounds DNS failure', async () => {
  const bootstrap = await resolveDhtBootstrap(async (host, options) => {
    assert.deepEqual(options, { family: 4, all: true });
    if (host === DHT_ROUTERS[0]) throw new Error('DNS unavailable');
    if (host === DHT_ROUTERS[1]) return new Promise(() => {});
    return [{ address: '127.0.0.1' }, { address: '127.0.0.2' }];
  }, 20);
  assert.deepEqual(bootstrap, [DHT_ROUTERS[0] + ':6881', DHT_ROUTERS[1] + ':6881', '127.0.0.1:6881', '127.0.0.2:6881']);
});

test('idle torrents retry discovery with backoff, while healthy, removed, and complete torrents do not', () => {
  const stalled = { addedAt: 1000, torrent: { destroyed: false }, file: { progress: 0 } };
  assert.equal(shouldRecoverDiscovery(stalled, 30000), false);
  assert.equal(shouldRecoverDiscovery(stalled, 31000), true);
  assert.equal(shouldRecoverDiscovery({ ...stalled, lastRefreshAt: 31000, recoveryAttempts: 1 }, 60000), false);
  assert.equal(shouldRecoverDiscovery({ ...stalled, lastRefreshAt: 31000, recoveryAttempts: 1 }, 71000), true);
  assert.equal(shouldRecoverDiscovery({ ...stalled, lastDataAt: 70000 }, 71000), false);
  assert.equal(shouldRecoverDiscovery({ ...stalled, file: { progress: 1 } }, 71000), false);
  assert.equal(shouldRecoverDiscovery({ ...stalled, error: 'removing' }, 71000), false);
  assert.equal(shouldRecoverDiscovery({ ...stalled, torrent: { destroyed: true } }, 71000), false);
});
