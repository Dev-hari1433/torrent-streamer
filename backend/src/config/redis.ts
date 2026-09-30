import { Redis } from 'ioredis';
import { config } from './env.js';

// One multiplexed connection. Cache outages must never block playback.
export const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, {
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
  connectTimeout: 1500, commandTimeout: 1500,
  retryStrategy: times => Math.min(times * 1000, 30000),
}) : null;
redis?.on('error', () => { /* Reported by /api/health; playback falls back to memory. */ });
export async function connectRedis() { await redis?.connect().catch(() => undefined); }
