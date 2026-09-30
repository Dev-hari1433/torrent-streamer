import type { Torrent, TorrentFile } from 'webtorrent';
import { EventEmitter } from 'node:events';

const MB = 1024 * 1024;
type Selection = { start: number; end: number; priority: number };
type Window = { offset: number; bufferedSeconds: number; touched: number };
type RuntimeSelection = { from: number; to: number; offset: number; priority: number; isStreamSelection: boolean };
// WebTorrent 3.0.21 merges public selections irrespective of priority. Maintain
// identity-owned entries in its pinned selection table, separate from iterator
// selections, so closing a read cannot remove an equal-bounds priority window.
type SelectionTorrent = Torrent & {
  _selections: { _items: RuntimeSelection[] };
  _updateSelections(): void;
};

export function pieceRange(fileOffset: number, fileLength: number, pieceLength: number, start: number, end: number) {
  if (fileLength <= 0 || pieceLength <= 0 || start >= fileLength || end < Math.max(0, start)) return null;
  return { start: Math.floor((fileOffset + Math.max(0, start)) / pieceLength),
    end: Math.floor((fileOffset + Math.min(fileLength - 1, end)) / pieceLength) };
}

export class PieceSelector extends EventEmitter {
  private selections: Selection[] = [];
  private owned = new Map<string, RuntimeSelection>();
  private windows = new Map<string, Window>();
  private closed = false;
  private announcedInitial = false;
  private bytesPerSecond = 0;
  setMediaDuration(duration: number) {
    if (duration > 0 && Number.isFinite(duration)) { this.bytesPerSecond = this.file.length / duration; this.rebuild(); }
  }
  private readonly onVerified = (index?: number) => {
    const range = pieceRange(this.file.offset, this.file.length, this.torrent.pieceLength, 0, this.initialBufferTargetBytes - 1);
    if (range && (index === undefined || (index >= range.start && index <= range.end)) && this.initialBufferReady) {
      if (!this.announcedInitial) { this.announcedInitial = true; this.rebuild(); }
      this.emit('initialBufferReady');
    }
  };
  private readonly onTorrentClose = () => this.destroy();
  constructor(readonly torrent: Torrent, readonly file: TorrentFile) {
    super();
    for (const item of torrent.files) item.deselect();
    torrent.on('verified', this.onVerified);
    torrent.once('close', this.onTorrentClose);
    this.updatePriorityWindow('warmup', 0, 0);
    this.onVerified();
  }

  get initialBufferTargetBytes() { return Math.min(this.file.length, 2 * MB); }
  get initialBufferReady() {
    if (this.closed || this.torrent.destroyed || this.initialBufferTargetBytes <= 0) return false;
    const range = pieceRange(this.file.offset, this.file.length, this.torrent.pieceLength, 0, this.initialBufferTargetBytes - 1)!;
    for (let index = range.start; index <= range.end; index++) if (!this.torrent.bitfield.get(index)) return false;
    return true;
  }
  get isClosed() { return this.closed || this.torrent.destroyed; }
  get firstMissingInitialPiece() {
    const range = pieceRange(this.file.offset, this.file.length, this.torrent.pieceLength, 0, this.initialBufferTargetBytes - 1);
    if (range) for (let index = range.start; index <= range.end; index++) if (!this.torrent.bitfield.get(index)) return index;
    return undefined;
  }
  refresh() { this.rebuild(); }

  updatePriorityWindow(owner: string, currentByteOffset: number, bufferedSeconds = 0) {
    this.windows.delete('warmup');
    const previous = this.windows.get(owner);
    this.windows.set(owner, { offset: Math.min(this.file.length - 1, Math.max(0, currentByteOffset)),
      bufferedSeconds, touched: Date.now() });
    if (previous && Math.floor(previous.offset / this.torrent.pieceLength) === Math.floor(currentByteOffset / this.torrent.pieceLength)
      && (previous.bufferedSeconds < 8) === (bufferedSeconds < 8)) return;
    this.rebuild();
  }
  release(owner: string) { this.windows.delete(owner); this.rebuild(); }
  sweep() {
    for (const [owner, window] of this.windows) if (Date.now() - window.touched > 30000) this.windows.delete(owner);
    this.rebuild();
  }
  private rebuild() {
    if (this.closed || this.torrent.destroyed) return;
    const next: Selection[] = [];
    const add = (start: number, end: number, priority: number) => {
      const range = pieceRange(this.file.offset, this.file.length, this.torrent.pieceLength, start, end);
      if (range) next.push({ ...range, priority });
    };
    // Piece zero of the selected video, not necessarily piece zero of a multi-file torrent.
    add(0, 0, 20);
    add(0, this.initialBufferTargetBytes - 1, 15);
    // WebTorrent validates new peers from the END of its lowest selection and
    // rotates nonzero priorities. Broad startup windows therefore send initial
    // requests far beyond the header, even with a higher header priority.
    // Keep only the small initial selection until it has been verified.
    if (this.initialBufferReady) {
    if (/\.mp4$/i.test(this.file.name)) {
      const header = Math.min(this.file.length, 2 * MB);
      add(0, header - 1, 5); add(this.file.length - header, this.file.length - 1, 5);
    } else add(0, 10 * MB - 1, 5);
    for (const [owner, window] of this.windows) {
      // A real read outranks speculative header prefetch and estimated playheads.
      const { urgent, ahead } = playbackWindow(this.bytesPerSecond, window.bufferedSeconds);
      add(window.offset, window.offset + urgent - 1, owner.startsWith('read:') ? 10 : 3);
      add(window.offset + urgent, window.offset + ahead - 1, 1);
      add(window.offset - 5 * MB, window.offset - 1, 1);
    }
    // Continue caching when idle, instead of stopping forever at the warmup
    // window. Urgent reader/playhead selections are processed first.
    add(0, this.file.length - 1, 0);
    }
    const unique = next.filter((s, i) => next.findIndex(t => t.start === s.start && t.end === s.end && t.priority === s.priority) === i);
    const key = (s: Selection) => `${s.start}:${s.end}:${s.priority}`;
    const previous = new Set(this.selections.map(key)); const current = new Set(unique.map(key));
    const torrent = this.torrent as SelectionTorrent;
    for (const old of this.selections) if (!current.has(key(old))) {
      const entry = this.owned.get(key(old));
      const index = entry ? torrent._selections._items.indexOf(entry) : -1;
      if (index >= 0) torrent._selections._items.splice(index, 1);
      this.owned.delete(key(old));
    }
    for (const selection of unique) if (!previous.has(key(selection))) {
      const entry = { from: selection.start, to: selection.end, offset: 0, priority: selection.priority, isStreamSelection: false };
      this.owned.set(key(selection), entry); torrent._selections._items.push(entry);
    }
    torrent._selections._items.sort((a, b) => b.priority - a.priority);
    torrent._updateSelections();
    for (const selection of unique) if (!previous.has(key(selection)) && [3, 10, 15, 20].includes(selection.priority)) this.torrent.critical(selection.start, selection.end);
    this.selections = unique;
  }
  bufferedBytes(offset = 0) {
    const absolute = this.file.offset + offset;
    let piece = Math.floor(absolute / this.torrent.pieceLength);
    let end = absolute;
    while (end < this.file.offset + this.file.length && this.torrent.bitfield.get(piece)) {
      end = Math.min((++piece) * this.torrent.pieceLength, this.file.offset + this.file.length);
    }
    return Math.max(0, end - absolute);
  }
  get playhead() { return [...this.windows.values()].at(-1)?.offset ?? 0; }
  get activePlayers() { return [...this.windows.keys()].filter(owner => owner.startsWith('player:')).length; }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.torrent.removeListener('verified', this.onVerified);
    this.torrent.removeListener('close', this.onTorrentClose);
    this.emit('closed');
    if (!this.torrent.destroyed) {
      const torrent = this.torrent as SelectionTorrent;
      for (const entry of this.owned.values()) {
        const index = torrent._selections._items.indexOf(entry);
        if (index >= 0) torrent._selections._items.splice(index, 1);
      }
      torrent._updateSelections();
    }
    this.owned.clear();
    this.selections = []; this.windows.clear();
  }
}

export function playbackWindow(bytesPerSecond: number, bufferedSeconds: number) {
  if (!(bytesPerSecond > 0)) return { urgent: 25 * MB, ahead: 75 * MB };
  return { urgent: Math.round(Math.min(64 * MB, Math.max(8 * MB, bytesPerSecond * (bufferedSeconds < 8 ? 30 : 12)))),
    ahead: Math.round(Math.min(192 * MB, Math.max(32 * MB, bytesPerSecond * 90))) };
}
