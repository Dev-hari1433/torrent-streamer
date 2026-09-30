import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream';
import { config } from '../config/env.js';
import type { TorrentEngine } from '../torrent/engine.js';
import { serveRange } from './rangeHandler.js';
import { waitForInitialBuffer } from './initialBuffer.js';

export interface MediaInfo {
  duration: number; startTime: number; videoCodec: string; audioCodec: string | null; width: number; height: number;
  mode: 'direct' | 'remux'; mime: string;
  qualities?: PlaybackQuality[]; seekPreroll?: number;
}
export const PLAYBACK_QUALITIES = ['original', '1080', '720', '480', '360'] as const;
export type PlaybackQuality = typeof PLAYBACK_QUALITIES[number];
export function availableQualities(height: number): PlaybackQuality[] {
  return PLAYBACK_QUALITIES.filter(value => value === 'original' || Number(value) < height);
}
interface ProbeResult {
  format?: { duration?: string; start_time?: string; format_name?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; has_b_frames?: number }[];
}
export function classifyMedia(fileName: string, probe: ProbeResult): MediaInfo {
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  if (!video?.codec_name) throw Object.assign(new Error('No video track found'), { statusCode: 415 });
  // A remux cannot make an unsupported video codec browser-decodable.
  if (!['h264', 'hevc', 'av1', 'vp9'].includes(video.codec_name)) {
    throw Object.assign(new Error(`Unsupported source video codec: ${video.codec_name}. Choose H.264, HEVC, AV1 or VP9 media.`), { statusCode: 415 });
  }
  const direct = /\.mp4$/i.test(fileName) && video.codec_name === 'h264' && (!audio || audio.codec_name === 'aac');
  return { duration: Number(probe.format?.duration ?? video.duration) || 0, startTime: Number(probe.format?.start_time) || 0,
    videoCodec: video.codec_name, audioCodec: audio?.codec_name ?? null,
    width: video.width ?? 0, height: video.height ?? 0, mode: direct ? 'direct' : 'remux', mime: 'video/mp4',
    qualities: availableQualities(video.height ?? 0),
    // FFmpeg's input seek subtracts 3/23s for reordered video in demuxers that
    // seek by DTS (including Matroska). Compensate to reach our probed keyframe.
    seekPreroll: video.has_b_frames && /matroska|webm/.test(probe.format?.format_name ?? '') ? 3 / 23 : 0 };
}

export function remuxArguments(url: string, start: number, info: MediaInfo, quality: PlaybackQuality = 'original') {
  if (!availableQualities(info.height).includes(quality)) throw Object.assign(new Error('This quality is unavailable for the source resolution'), { statusCode: 400 });
  const original = quality === 'original';
  const rate = ({ '1080': '5000k', '720': '2800k', '480': '1400k', '360': '800k' } as const)[quality as Exclude<PlaybackQuality, 'original'>];
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-rw_timeout', '30000000',
    '-probesize', '2097152', '-analyzeduration', '750000',
    '-fflags', '+genpts+discardcorrupt', ...(start > 0 ? ['-seek_timestamp', '1', '-ss', String(start + info.startTime + (original ? info.seekPreroll ?? 0 : 0)),
      ...(original ? ['-noaccurate_seek'] : [])] : []),
    '-threads', '2', '-i', url, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    ...(original ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', rate, '-bufsize', String(parseInt(rate) * 2) + 'k',
      '-vf', `scale=-2:${quality}`, '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '1', '-force_key_frames', 'expr:gte(t,n_forced*2)']),
    ...(original && info.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(info.audioCodec && (!original || info.audioCodec !== 'aac') ? ['-c:a', 'aac', '-b:a', '192k',
      '-af', 'aresample=async=1:min_hard_comp=0.100000'] : ['-c:a', 'copy']),
    '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '2048',
    // Wait for real track timestamps before writing edit lists. empty_moov alone
    // resets initial audio timing and loses AAC priming / reordered-video offsets.
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-frag_duration', '1000000', '-flush_packets', '1', 'pipe:1'];
}

export class MediaService {
  private token = randomBytes(32).toString('hex');
  private port = 0;
  private children = new Map<ChildProcess, string>();
  private cache = new Map<string, MediaInfo>();
  private probes = new Map<string, Promise<MediaInfo>>();
  private seekCache = new Map<string, number>();
  private closing = false;
  private warmup = Promise.resolve();
  private readonly onPlayable = (hash: string) => {
    // Prepare tracks while the dashboard is open. Serialize speculative probes
    // and reserve a worker for foreground playback; inspect deduplicates requests.
    this.warmup = this.warmup.then(async () => {
      if (this.closing || !this.engine.sessions.has(hash) || this.children.size >= config.MAX_MEDIA_PROCESSES - 1) return;
      try { await this.inspect(hash); }
      catch { /* Playback can retry; speculative inspection must not fail the torrent. */ }
    });
  };
  readonly metrics = { probes: 0, seekProbes: 0, seekCacheHits: 0, remuxes: 0 };
  private server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== this.token || !['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(403); res.end(); return;
    }
    try { serveRange(req, res, this.engine.ready(url.pathname.slice(1)), 'application/octet-stream'); }
    catch { res.writeHead(404); res.end(); }
  });
  constructor(private engine: TorrentEngine, private options: { initialBufferTimeoutMs?: number } = {}) {
    engine.on('playable', this.onPlayable);
  }
  get activeProcesses() { return this.children.size; }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (address && typeof address !== 'string') this.port = address.port;
  }
  private source(hash: string) { return `http://127.0.0.1:${this.port}/${hash}?token=${this.token}`; }
  private track(child: ChildProcess, hash: string) {
    this.children.set(child, hash);
    child.once('close', () => this.children.delete(child));
  }
  private capacity() {
    if (this.children.size >= config.MAX_MEDIA_PROCESSES) throw Object.assign(new Error('Media worker limit reached. Try again shortly.'), { statusCode: 429 });
  }
  private async waitForHeader(hash: string, signal?: AbortSignal) {
    await waitForInitialBuffer(this.engine.ready(hash).selector, { signal, timeoutMs: this.options.initialBufferTimeoutMs });
  }
  async inspect(hash: string, signal?: AbortSignal): Promise<MediaInfo> {
    await this.waitForHeader(hash, signal);
    if (this.cache.has(hash)) return this.cache.get(hash)!;
    if (this.probes.has(hash)) return this.probes.get(hash)!;
    this.capacity();
    const session = this.engine.ready(hash);
    const job = this.probe(hash); this.probes.set(hash, job);
    try {
      const info = await job;
      if (this.engine.sessions.get(hash) === session) {
        this.cache.set(hash, info); session.selector.setMediaDuration(info.duration);
      }
      return info;
    }
    finally { this.probes.delete(hash); }
  }
  private probe(hash: string, extended = false): Promise<MediaInfo> {
    const started = Date.now();
    this.metrics.probes++;
    return new Promise((resolve, reject) => {
      const child = spawn(config.FFPROBE_PATH, ['-v', 'error', '-rw_timeout', '20000000', '-probesize', extended ? '10000000' : '2097152',
        '-analyzeduration', extended ? '5000000' : '750000', '-show_streams', '-show_format', '-of', 'json', this.source(hash)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.track(child, hash);
      let output = ''; let error = ''; let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45000);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 2_000_000) child.kill('SIGKILL'); });
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-4000); });
      child.once('error', () => reject(Object.assign(new Error('FFprobe is unavailable. Install FFmpeg and set FFPROBE_PATH.'), { statusCode: 503 })));
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(Object.assign(new Error(timedOut ? 'Media inspection timed out waiting for pieces' : `Media inspection failed: ${error.replaceAll(this.source(hash), '[local source]')}`), { statusCode: 422 })); return; }
        try {
          const info = classifyMedia(this.engine.ready(hash).file.name, JSON.parse(output) as ProbeResult);
          if (!extended && (!info.width || !info.height || !info.duration)) { resolve(this.probe(hash, true)); return; }
          console.info(JSON.stringify({ event: 'media.inspected', hash: hash.slice(0, 8), elapsedMs: Date.now() - started, extended }));
          resolve(info);
        }
        catch (error) { reject(error); }
      });
    });
  }
  async seekPoint(hash: string, requested: number, signal?: AbortSignal): Promise<number> {
    const info = await this.inspect(hash, signal);
    signal?.throwIfAborted();
    if (requested <= 0 || info.mode === 'direct') return Math.max(0, requested);
    if (info.duration && requested >= info.duration) throw Object.assign(new Error('Seek exceeds duration'), { statusCode: 416 });
    const cacheKey = `${hash}:${requested.toFixed(3)}`;
    const cached = this.seekCache.get(cacheKey);
    if (cached !== undefined) { this.metrics.seekCacheHits++; return cached; }
    this.capacity();
    // Probe only the indexed video packet at the demuxer's seek point. Both
    // tracks then restart at this source keyframe, instead of giving the UI an
    // invented exact time while video preroll begins earlier.
    this.metrics.seekProbes++;
    return new Promise((resolve, reject) => {
      const child = spawn(config.FFPROBE_PATH, ['-v', 'error', '-rw_timeout', '20000000', '-probesize', '2097152', '-analyzeduration', '750000', '-read_intervals', `${requested + info.startTime}%+#1`,
        '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,flags,pos', '-of', 'json', this.source(hash)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.track(child, hash); let output = '';
      const abort = () => { child.kill('SIGKILL'); reject(signal?.reason ?? new Error('Seek cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 100000) child.kill('SIGKILL'); });
      child.stderr.resume(); child.once('error', () => reject(Object.assign(new Error('Seek inspection could not start'), { statusCode: 503 })));
      child.once('close', code => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return;
        try {
          const packet = (JSON.parse(output) as { packets?: { pts_time?: string; flags?: string; pos?: string }[] }).packets?.[0];
          const timestamp = Number(packet?.pts_time);
          if (code !== 0 || !packet?.flags?.includes('K') || !Number.isFinite(timestamp)) throw new Error('No indexed keyframe is available at this position');
          const point = Math.max(0, timestamp - info.startTime);
          this.seekCache.set(cacheKey, point);
          if (this.seekCache.size > 128) this.seekCache.delete(this.seekCache.keys().next().value!);
          const position = Number(packet?.pos);
          if (Number.isSafeInteger(position) && position >= 0) this.engine.ready(hash).selector.updatePriorityWindow('seek', position);
          resolve(point);
        } catch { reject(Object.assign(new Error('Could not locate a seek keyframe. Wait for more pieces and retry.'), { statusCode: 422 })); }
      });
    });
  }
  async stream(hash: string, start: number, info: MediaInfo, res: ServerResponse, signal?: AbortSignal, quality: PlaybackQuality = 'original') {
    await this.waitForHeader(hash, signal);
    if (res.destroyed) return;
    this.capacity();
    this.metrics.remuxes++;
    const started = Date.now();
    const child = spawn(config.FFMPEG_PATH, remuxArguments(this.source(hash), start, info, quality),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.track(child, hash);
    let error = ''; let finished = false; let cancelled = false;
    const cleanup = () => { if (!finished) { finished = true; child.kill('SIGKILL'); child.stdout.destroy(); } };
    const disconnected = () => { if (!res.writableFinished) cancelled = true; cleanup(); };
    res.once('close', disconnected);
    const firstByteTimer = setTimeout(() => { cleanup(); res.destroy(new Error('Timed out waiting for media')); }, 45000);
    child.stdout.once('data', () => {
      clearTimeout(firstByteTimer);
      console.info(JSON.stringify({ event: 'media.firstBytes', hash: hash.slice(0, 8), elapsedMs: Date.now() - started, start, quality }));
    });
    child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
    child.once('error', () => {
      if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('FFmpeg is unavailable'); }
      else res.destroy();
    });
    child.once('close', code => {
      clearTimeout(firstByteTimer);
      if (code !== 0 && !cancelled) {
        if (error) console.error(`FFmpeg ${hash.slice(0, 8)}: ${error.replaceAll(this.source(hash), '[local source]')}`);
        if (!res.destroyed) res.destroy();
      }
    });
    res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'none'); res.setHeader('X-Playback-Start', String(start));
    pipeline(child.stdout, res, pipelineError => {
      clearTimeout(firstByteTimer);
      if (pipelineError && ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes((pipelineError as NodeJS.ErrnoException).code ?? '')) cancelled = true;
      cleanup(); res.removeListener('close', disconnected);
    });
  }
  forget(hash: string) {
    this.cache.delete(hash);
    for (const key of this.seekCache.keys()) if (key.startsWith(`${hash}:`)) this.seekCache.delete(key);
    for (const [child, owner] of this.children) if (owner === hash) child.kill('SIGKILL');
  }
  async close() {
    this.closing = true; this.engine.removeListener('playable', this.onPlayable);
    for (const child of this.children.keys()) child.kill('SIGKILL');
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
