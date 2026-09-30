import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

const env = z.object({
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
  REDIS_URL: z.string().optional(), DATA_DIR: z.string().default('./data'),
  FFMPEG_PATH: z.string().optional(), FFPROBE_PATH: z.string().optional(),
  SUPABASE_URL: z.string().optional(), SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  MAX_ACTIVE_TORRENTS: z.coerce.number().int().positive().default(8),
  MAX_MEDIA_PROCESSES: z.coerce.number().int().positive().default(4),
  METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  UPLOAD_LIMIT_BYTES: z.coerce.number().int().min(-1).default(3000000),
  MAX_PEER_CONNECTIONS: z.coerce.number().int().min(20).max(250).default(100),
  MAX_FILE_BYTES: z.coerce.number().int().nonnegative().default(0),
}).parse(process.env);
const require = createRequire(import.meta.url);
export const config = { ...env, DATA_DIR: resolve(env.DATA_DIR),
  FFMPEG_PATH: env.FFMPEG_PATH || (require('ffmpeg-static') as string | null) || 'ffmpeg',
  FFPROBE_PATH: env.FFPROBE_PATH || (require('ffprobe-static') as { path: string }).path || 'ffprobe',
};
