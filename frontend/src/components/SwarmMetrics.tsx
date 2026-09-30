import { ArrowDown, ArrowUp, Network, Radio } from 'lucide-react';
import { bytes, type TorrentState } from '@/lib/api';
export default function SwarmMetrics({ torrents, connected }: { torrents: TorrentState[]; connected: boolean }) {
  const download = torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0);
  const upload = torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0);
  const peers = torrents.reduce((sum, torrent) => sum + torrent.numPeers, 0);
  return <section className="metrics" aria-label="Live swarm metrics">
    <div><span className="metric-label"><ArrowDown size={16} /> Download</span><strong>{bytes(download)}<small>/s</small></strong><span className="metric-note">Across active streams</span></div>
    <div><span className="metric-label"><ArrowUp size={16} /> Upload</span><strong>{bytes(upload)}<small>/s</small></strong><span className="metric-note">Shared with connected peers</span></div>
    <div><span className="metric-label"><Network size={16} /> Connected peers</span><strong>{peers.toString().padStart(2, '0')}<small>peers</small></strong><span className="metric-note">Distributed across the swarm</span></div>
    <div><span className="metric-label"><Radio size={16} /> Engine status</span><strong className={connected ? 'mint' : ''}>{connected ? 'Online' : 'Offline'}<i className={`status-dot ${connected ? 'live' : ''}`} /></strong><span className="metric-note">{connected ? 'Live updates every 500 ms' : 'Reconnecting to the local engine'}</span></div>
  </section>;
}
