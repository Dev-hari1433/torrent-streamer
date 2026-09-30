export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';
export interface TorrentState {
  infoHash: string; name: string; fileName?: string; fileSize: number;
  downloadSpeed: number; uploadSpeed: number; numPeers: number; progress: number;
  bufferedBytes: number; bufferedPercent: number; status: 'resolving' | 'downloading' | 'streaming' | 'complete' | 'error'; error?: string;
  initialBufferReady: boolean; initialBufferBytes: number; initialBufferTargetBytes: number;
  diagnostics?: { phase: string; message: string; idleSeconds: number; unchokedPeers: number; transferringPeers: number;
    headerPeers: number; receivedBytes: number; verifiedBytes: number; trackerAnnounces: number; dhtAnnounces: number;
    dhtNodes?: number; initialReadyMs?: number; lastWarning?: string; retryAfterMs: number };
}
export type PlaybackQuality = 'original' | '1080' | '720' | '480' | '360';
export interface MediaInfo {
  duration: number; videoCodec: string; audioCodec: string | null; width: number; height: number; mode: 'direct' | 'remux'; mime: string;
  qualities?: PlaybackQuality[];
}
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API}${path}`, { ...options, cache: 'no-store', signal: options?.signal ?? AbortSignal.timeout(90000) }); }
  catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new ApiError('Cannot reach the local streaming engine. Start Lumora, then retry.', 0, 'ENGINE_OFFLINE');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body?.code);
  }
  return response.json() as Promise<T>;
}
export const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function bytes(value: number) {
  if (value < 1024) return `${Math.round(value)} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function time(value: number) {
  if (!Number.isFinite(value)) return '0:00';
  const seconds = Math.floor(Math.max(0, value));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
