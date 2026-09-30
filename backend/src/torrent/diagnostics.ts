import type { TorrentSession } from './engine.js';

export function swarmDiagnostics(session: TorrentSession, now = Date.now()) {
  const { torrent, selector, file } = session;
  const wires = torrent.wires ?? [];
  const unchokedPeers = wires.filter(wire => !wire.peerChoking).length;
  const transferringPeers = wires.filter(wire => wire.downloadSpeed() > 1024).length;
  const missing = selector?.firstMissingInitialPiece;
  const headerPeers = missing === undefined ? 0 : wires.filter(wire => wire.peerPieces.get(missing)).length;
  const idleSeconds = Math.max(0, Math.floor((now - (session.lastDataAt ?? session.addedAt)) / 1000));
  let phase = 'connecting'; let message = 'Finding peers for this torrent…';
  if (session.error) { phase = 'error'; message = session.error; }
  else if (!file) { phase = 'metadata'; message = 'Waiting for a peer to provide torrent metadata…'; }
  else if (file.progress === 1) { phase = 'complete'; message = 'Downloaded. Playback is ready from local storage.'; }
  else if (selector?.initialBufferReady) { phase = 'ready'; message = idleSeconds >= 20 ? 'Ready to start; waiting for peers to supply more video.' : 'Ready to play. Downloading ahead of playback.'; }
  else if (idleSeconds < 15) { phase = 'buffering'; message = 'Downloading and verifying the first video pieces…'; }
  else if (!wires.length) { phase = 'no-peers'; message = 'No connected peers. Refresh discovery or try a torrent with available seeders.'; }
  else if (!headerPeers) { phase = 'missing-pieces'; message = 'Connected peers do not currently have the next required header piece. Waiting for a seeder.'; }
  else if (!unchokedPeers) { phase = 'choked'; message = 'Peers are connected but are not allowing downloads yet. Waiting for an upload slot.'; }
  else { phase = 'stalled'; message = 'Peers have the required piece but are not sending it. Refresh discovery or try another source.'; }
  return { phase, message, idleSeconds, unchokedPeers, transferringPeers, headerPeers,
    receivedBytes: torrent.received || 0, verifiedBytes: file?.downloaded || 0,
    trackerAnnounces: session.trackerAnnounces ?? 0, dhtAnnounces: session.dhtAnnounces ?? 0,
    lastWarning: session.lastWarning, retryAfterMs: Math.max(0, 30000 - (now - (session.lastRefreshAt ?? 0))) };
}
