import WebTorrent, { type Options, type Torrent, type TorrentFile, type TorrentOptions } from 'webtorrent';
import parseTorrent from 'parse-torrent';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { config } from '../config/env.js';
import { metadataCache } from './metadataCache.js';
import { PieceSelector } from './pieceSelector.js';
import { sessionStore } from './sessionStore.js';
import { swarmDiagnostics } from './diagnostics.js';
import { SparseFileStore } from './sparseStore.js';
import { downloadDirectory, eraseDownload } from './downloadStorage.js';
import { DHT_ROUTERS, shouldRecoverDiscovery } from './discovery.js';

export const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce',
  'http://tracker.opentrackr.org:1337/announce', 'udp://tracker.torrent.eu.org:451/announce',
];
export function normalizeMagnet(input: string) {
  input = input.trim().replace(/^magnet:/i, 'magnet:');
  if (!input.startsWith('magnet:?') || input.length > 16384) throw Object.assign(new Error('Enter a valid magnet URI'), { statusCode: 400 });
  const url = new URL(input);
  if (!url.searchParams.getAll('xt').some(xt => /^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i.test(xt))) {
    throw Object.assign(new Error('A BitTorrent v1 info hash is required'), { statusCode: 400 });
  }
  // Do not let magnet exact-source URLs make arbitrary HTTP requests from this host.
  for (const param of ['xs', 'as', 'ws']) url.searchParams.delete(param);
  const trackers = new Set(url.searchParams.getAll('tr'));
  if (trackers.size < 3) for (const tracker of FALLBACK_TRACKERS) if (!trackers.has(tracker)) url.searchParams.append('tr', tracker);
  // magnet-uri decodes tracker/name parameters, but does NOT decode xt.
  // URLSearchParams serializes urn:btih: as urn%3Abtih%3A, which otherwise
  // makes every normalized magnet fail parse-torrent before discovery starts.
  return `magnet:?${[...url.searchParams].map(([key, value]) => {
    const encoded = encodeURIComponent(key === 'xt' ? value.replace(/^urn:btih:/i, 'urn:btih:') : value);
    return `${encodeURIComponent(key)}=${key === 'xt' || key === 'x.pe' ? encoded.replace(/%3A/gi, ':') : encoded}`;
  }).join('&')}`;
}

export interface TorrentSession {
  infoHash: string; name: string; torrent: Torrent; file?: TorrentFile;
  selector?: PieceSelector; error?: string; readers: number; addedAt: number;
  source?: string | Buffer; lastDataAt?: number; lastRefreshAt?: number;
  trackerAnnounces?: number; dhtAnnounces?: number; lastWarning?: string;
  recoveryAttempts?: number; initialReadyAt?: number; lastDiagnosticAt?: number;
}
export class TorrentEngine extends EventEmitter {
  readonly client: WebTorrent;
  readonly sessions = new Map<string, TorrentSession>();
  private pending = new Map<string, Promise<TorrentSession>>();
  private removals = new Map<string, Promise<void>>();
  private wires = 0;
  private saves = new Map<string, Promise<void>>();
  private timer = setInterval(() => this.maintain(), 5000);
  constructor(options: Options = {}) {
    super();
    this.client = new WebTorrent({ maxConns: config.MAX_PEER_CONNECTIONS, uploadLimit: config.UPLOAD_LIMIT_BYTES, lsd: true, utPex: true, utp: false,
      tracker: { announce: FALLBACK_TRACKERS },
      dht: { bootstrap: DHT_ROUTERS.map(host => `${host}:6881`) }, ...options });
    this.client.on('error', error => { console.error('Torrent engine:', String(error)); });
    this.timer.unref();
  }
  async add(input: string | Buffer): Promise<TorrentSession> {
    let parsed;
    const source = typeof input === 'string' ? normalizeMagnet(input) : input;
    try { parsed = await parseTorrent(source); } catch { throw Object.assign(new Error('Invalid torrent metadata'), { statusCode: 400 }); }
    const hash = parsed.infoHash?.toLowerCase();
    if (!hash || !/^[a-f0-9]{40}$/.test(hash)) throw Object.assign(new Error('Unsupported torrent info hash'), { statusCode: 400 });
    await this.removals.get(hash);
    if (this.sessions.has(hash)) {
      const existing = this.sessions.get(hash)!;
      // Uploaded metadata can rescue a magnet whose metadata discovery stalled.
      if (Buffer.isBuffer(source) && (!existing.file || existing.torrent.destroyed)) {
        await this.remove(hash, false); return this.add(source);
      }
      return existing;
    }
    if (this.pending.has(hash)) return this.pending.get(hash)!;
    if (this.sessions.size + this.pending.size >= config.MAX_ACTIVE_TORRENTS) throw Object.assign(new Error('Active torrent limit reached'), { statusCode: 429 });
    const promise = this.create(hash, source, parsed.name || hash, parsed.announce ?? []);
    this.pending.set(hash, promise);
    try { return await promise; } finally { this.pending.delete(hash); }
  }
  private async create(hash: string, source: string | Buffer, name: string, submittedTrackers: string[]) {
    const cached = typeof source === 'string' ? await metadataCache.get(hash) : undefined;
    let input = source;
    let announce: string[] = [];
    if (cached) {
      try {
        const parsed = await parseTorrent(cached);
        if (parsed.infoHash === hash) { input = cached; if (!parsed.private) announce = submittedTrackers; }
      } catch { /* Ignore corrupt cache. */ }
    }
    await mkdir(config.DATA_DIR, { recursive: true });
    const torrent = this.client.add(input, { path: config.DATA_DIR, addUID: true, deselect: true, announce,
      // WebTorrent constructs stores with `new`; its legacy types incorrectly declare a callable factory.
      strategy: 'sequential', destroyStoreOnDestroy: false, storeCacheSlots: 32,
      store: SparseFileStore as unknown as NonNullable<TorrentOptions['store']> });
    const session: TorrentSession = { infoHash: hash, name, torrent, readers: 0, addedAt: Date.now(), source: input };
    this.sessions.set(hash, session);
    this.persist(session, input);
    const timer = setTimeout(() => {
      if (!session.file) { session.error = 'Metadata discovery timed out. Remove and retry with reachable peers.'; torrent.destroy(); }
    }, config.METADATA_TIMEOUT_MS);
    timer.unref();
    torrent.on('error', error => { clearTimeout(timer); session.error = String(error); });
    torrent.on('warning', warning => {
      // Tracker URLs can contain passkeys; keep only a bounded, redacted diagnostic.
      session.lastWarning = String(warning).replace(/(?:https?|wss?|udp):\/\/\S+/g, '[tracker]').slice(0, 240);
      console.warn(`Torrent ${hash.slice(0, 8)}: ${session.lastWarning}`);
    });
    torrent.on('download', () => { session.lastDataAt = Date.now(); session.recoveryAttempts = 0; });
    torrent.on('trackerAnnounce', () => { session.trackerAnnounces = (session.trackerAnnounces ?? 0) + 1; });
    torrent.on('dhtAnnounce', () => { session.dhtAnnounces = (session.dhtAnnounces ?? 0) + 1; });
    torrent.on('wire', wire => {
      if (this.wires >= 250) { wire.destroy(); return; }
      this.wires++; wire.once('close', () => { this.wires--; });
    });
    torrent.once('ready', () => {
      clearTimeout(timer);
      const file = torrent.files.filter(f => /\.(mp4|mkv|avi|webm)$/i.test(f.name)).sort((a, b) => b.length - a.length)[0];
      if (!file) { session.error = 'No supported video file found'; torrent.destroy(); return; }
      if (config.MAX_FILE_BYTES && file.length > config.MAX_FILE_BYTES) {
        session.error = `This video exceeds the hosted file limit of ${Math.round(config.MAX_FILE_BYTES / 1024 ** 2)} MiB. Use Lumora locally for larger files.`;
        torrent.destroy(); return;
      }
      session.name = torrent.name; session.file = file;
      session.selector = new PieceSelector(torrent, file);
      const playable = () => {
        session.initialReadyAt = Date.now();
        console.info(JSON.stringify({ event: 'torrent.playable', hash: hash.slice(0, 8),
          elapsedMs: session.initialReadyAt - session.addedAt, peers: torrent.numPeers, downloadSpeed: torrent.downloadSpeed }));
        this.emit('playable', hash);
      };
      if (session.selector.initialBufferReady) playable();
      else session.selector.once('initialBufferReady', playable);
      session.source = Buffer.from(torrent.torrentFile); this.persist(session, session.source);
      void metadataCache.put(hash, torrent.torrentFile).catch(error => console.warn('Metadata cache:', String(error)));
      console.info(JSON.stringify({ event: 'torrent.ready', hash: hash.slice(0, 8), bytes: file.length, trackers: torrent.announce.length }));
    });
    torrent.once('close', () => clearTimeout(timer));
    return session;
  }
  get(hash: string) {
    const session = this.sessions.get(hash);
    if (!session) throw Object.assign(new Error('Torrent not found'), { statusCode: 404 });
    return session;
  }
  private maintain() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      session.selector?.sweep();
      if (shouldRecoverDiscovery(session, now)) {
        session.recoveryAttempts = (session.recoveryAttempts ?? 0) + 1;
        void this.refresh(session.infoHash).catch(error => console.warn('Discovery recovery:', String(error)));
      }
      if (!session.error && session.file?.progress !== 1 && now - (session.lastDiagnosticAt ?? 0) >= 15000) {
        session.lastDiagnosticAt = now;
        const state = this.snapshot(session);
        console.info(JSON.stringify({ event: 'torrent.progress', hash: session.infoHash.slice(0, 8), elapsedMs: now - session.addedAt,
          phase: state.diagnostics.phase, peers: state.numPeers, downloadSpeed: state.downloadSpeed,
          verifiedBytes: state.diagnostics.verifiedBytes, headerBytes: state.initialBufferBytes,
          dhtNodes: this.discoveryState.nodes, recoveries: session.recoveryAttempts ?? 0 }));
      }
    }
  }
  get discoveryState() {
    const dht = (this.client as WebTorrent & { dht?: { toJSON(): { nodes: unknown[] } } | false }).dht;
    return { enabled: !!dht, nodes: dht ? dht.toJSON().nodes.length : 0 };
  }
  ready(hash: string) {
    const session = this.get(hash);
    if (session.error) throw Object.assign(new Error(session.error), { statusCode: 422 });
    if (!session.file) throw Object.assign(new Error('Torrent metadata is still resolving'), { statusCode: 409 });
    return session as TorrentSession & { file: TorrentFile; selector: PieceSelector };
  }
  snapshot(session: TorrentSession) {
    const { torrent, file, selector } = session;
    const bufferedBytes = selector?.bufferedBytes(selector.playhead) ?? 0;
    return { infoHash: session.infoHash, name: session.name, fileName: file?.name, fileSize: file?.length ?? 0,
      downloadSpeed: torrent.downloadSpeed || 0, uploadSpeed: torrent.uploadSpeed || 0,
      numPeers: torrent.numPeers || 0, progress: file?.progress ?? 0, bufferedBytes,
      initialBufferReady: selector?.initialBufferReady ?? false,
      initialBufferBytes: selector ? Math.min(selector.bufferedBytes(0), selector.initialBufferTargetBytes) : 0,
      initialBufferTargetBytes: selector?.initialBufferTargetBytes ?? 0,
      diagnostics: { ...swarmDiagnostics(session), dhtNodes: this.client ? this.discoveryState.nodes : 0,
        initialReadyMs: session.initialReadyAt === undefined ? undefined : session.initialReadyAt - session.addedAt },
      bufferedPercent: file ? bufferedBytes / file.length : 0,
      status: session.error ? 'error' : !file ? 'resolving' : session.readers > 0 || (selector?.activePlayers ?? 0) > 0 ? 'streaming' : file.progress === 1 ? 'complete' : 'downloading', error: session.error };
  }
  async remove(hash: string, deleteData = true) {
    if (this.removals.has(hash)) return this.removals.get(hash)!;
    const removal = this.removeSession(hash, deleteData);
    this.removals.set(hash, removal);
    try { await removal; } finally { this.removals.delete(hash); }
  }
  private async removeSession(hash: string, deleteData: boolean) {
    const session = this.get(hash);
    const directory = deleteData ? downloadDirectory(config.DATA_DIR, session.torrent.name, hash) : undefined;
    session.error = 'Removing stream and downloaded data…';
    session.selector?.destroy();
    try {
      // WebTorrent's async remove resolves before storage closes; its callback
      // is the completion signal. Close readers before deleting Windows files.
      if (!session.torrent.destroyed) await new Promise<void>((resolve, reject) => {
        void this.client.remove(hash, { destroyStore: false }, error => error ? reject(error) : resolve()).catch(reject);
      });
      if (deleteData) await eraseDownload(config.DATA_DIR, directory);
      await this.saves.get(hash); await sessionStore.remove(hash); this.saves.delete(hash);
      await metadataCache.forget(hash, deleteData);
      this.sessions.delete(hash);
    } catch (error) {
      session.error = 'Could not erase downloaded data. Close programs using the files and retry Remove.';
      throw Object.assign(new Error(session.error, { cause: error }), { statusCode: 503 });
    }
  }
  async restore() {
    for (const record of (await sessionStore.load()).slice(0, config.MAX_ACTIVE_TORRENTS)) {
      try {
        if ((await parseTorrent(record.source)).infoHash === record.hash) await this.add(record.source);
      } catch (error) { console.warn(`Restore ${record.hash.slice(0, 8)}: ${String(error)}`); }
    }
    for (const hash of (await metadataCache.sessions()).slice(0, config.MAX_ACTIVE_TORRENTS)) {
      const bytes = await metadataCache.get(hash);
      if (bytes) await this.add(bytes).catch(() => undefined);
    }
  }
  async destroy() {
    clearInterval(this.timer);
    await Promise.all(this.saves.values());
    for (const session of this.sessions.values()) session.selector?.destroy();
    await new Promise<void>(resolve => this.client.destroy(() => resolve()));
  }
  private persist(session: TorrentSession, source: string | Buffer) {
    const hash = session.infoHash;
    const save = (this.saves.get(hash) ?? Promise.resolve()).then(async () => {
      if (this.sessions.get(hash) === session) await sessionStore.save(hash, source);
    })
      .catch(error => console.warn(`Session persistence ${hash.slice(0, 8)}: ${String(error)}`));
    this.saves.set(hash, save);
  }
  async refresh(hash: string) {
    const session = this.get(hash); const now = Date.now();
    if (now - (session.lastRefreshAt ?? 0) < 30000) return this.snapshot(session);
    if (session.torrent.destroyed && session.source) {
      const source = session.source; await this.remove(hash, false);
      const restarted = await this.add(source); restarted.lastRefreshAt = now; return this.snapshot(restarted);
    }
    session.lastRefreshAt = now;
    const discovery = (session.torrent as Torrent & { discovery?: { tracker?: { update(): void } } }).discovery;
    discovery?.tracker?.update();
    const dht = (this.client as WebTorrent & { dht?: { lookup(hash: string): void } | false }).dht;
    if (dht && !(session.torrent as Torrent & { private?: boolean }).private) dht.lookup(hash);
    session.selector?.refresh();
    return this.snapshot(session);
  }
}
