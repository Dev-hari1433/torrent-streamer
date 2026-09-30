'use client';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, bytes, type TorrentState } from '@/lib/api';

export default function StreamDiagnostics({ torrent }: { torrent: TorrentState }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const details = torrent.diagnostics;
  if (!details) return null;
  async function refresh() {
    setBusy(true); setError('');
    try { await api(`/api/torrents/${torrent.infoHash}/refresh`, { method: 'POST' }); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="stream-diagnostics">
    <p role="status">{details.message}</p>
    <div className="diagnostic-actions"><details><summary>Connection details</summary>
      <dl><dt>Peers sending data</dt><dd>{details.transferringPeers} / {torrent.numPeers}</dd>
        <dt>Peers allowing downloads</dt><dd>{details.unchokedPeers}</dd>
        {!torrent.initialBufferReady && <><dt>Peers with the next header piece</dt><dd>{details.headerPeers}</dd></>}
        <dt>Received / verified</dt><dd>{bytes(details.receivedBytes)} / {bytes(details.verifiedBytes)}</dd>
        <dt>Last data received</dt><dd>{details.idleSeconds}s ago</dd>
        <dt>Tracker responses</dt><dd>{details.trackerAnnounces}</dd>
        <dt>DHT nodes reached</dt><dd>{details.dhtNodes ?? 0}</dd>
        {details.initialReadyMs !== undefined && <><dt>Initial buffer ready in</dt><dd>{(details.initialReadyMs / 1000).toFixed(1)}s</dd></>}
      </dl>
      {details.lastWarning && <p>{details.lastWarning}</p>}
    </details><button className="secondary compact" onClick={() => void refresh()} disabled={busy || details.retryAfterMs > 0}><RefreshCw size={13} className={busy ? 'spin' : ''} />{busy ? 'Refreshing…' : details.retryAfterMs > 0 ? `Retry in ${Math.ceil(details.retryAfterMs / 1000)}s` : 'Refresh peers'}</button></div>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
