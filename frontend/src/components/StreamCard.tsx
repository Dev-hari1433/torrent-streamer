import Link from 'next/link';
import { ArrowDown, ArrowUp, Play, Users, X, Film, LoaderCircle } from 'lucide-react';
import { bytes, type TorrentState } from '@/lib/api';
import StreamDiagnostics from './StreamDiagnostics';
export default function StreamCard({ torrent, onRemove, removing = false }: { torrent: TorrentState; onRemove: () => void; removing?: boolean }) {
  const waiting = !!torrent.fileName && torrent.status !== 'error' && !torrent.initialBufferReady;
  const available = !removing && torrent.status !== 'resolving' && torrent.status !== 'error' && torrent.initialBufferReady;
  return <article className="stream-card">
    <div className="film-tile"><Film size={28} /><small>{torrent.fileName?.split('.').at(-1)?.toUpperCase() ?? 'P2P'}</small></div>
    <div className="stream-details"><div className="stream-title"><h3 title={torrent.name}>{torrent.name}</h3><span className={`badge ${torrent.status}`}>{torrent.status}</span></div>
      <p>{torrent.fileSize ? bytes(torrent.fileSize) : 'Discovering metadata'}<span>·</span><Users size={13} />{torrent.numPeers} peers</p>
      <div className="buffer-track" role="progressbar" aria-label="Downloaded" aria-valuenow={Math.round(torrent.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${torrent.progress * 100}%` }} /></div>
      <div className="stream-foot"><span><ArrowDown size={13} />{bytes(torrent.downloadSpeed)}/s</span><span><ArrowUp size={13} />{bytes(torrent.uploadSpeed)}/s</span><span className="ml-auto">{(torrent.progress * 100).toFixed(1)}% downloaded</span></div>
      {torrent.error && <p className="error">{torrent.error}</p>}
      {waiting && <p role="status">Buffering initial pieces... {bytes(torrent.initialBufferBytes ?? 0)} / {bytes(torrent.initialBufferTargetBytes ?? 0)}</p>}
      <StreamDiagnostics torrent={torrent} />
    </div>
    <div className="stream-actions">{available ? <Link className="play-button" href={`/watch/${torrent.infoHash}`} aria-label={`Watch ${torrent.name}`}><Play size={18} fill="currentColor" /></Link> : <button type="button" className="play-button" disabled aria-label={waiting ? 'Buffering initial pieces...' : 'Video is not ready'} title={waiting ? 'Buffering initial pieces...' : 'Video is not ready'}>{waiting ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}</button>}<button className="icon-button" onClick={onRemove} disabled={removing} aria-label={`Remove and delete downloaded data for ${torrent.name}`} title="Remove stream and delete downloaded data">{removing ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}</button></div>
  </article>;
}
