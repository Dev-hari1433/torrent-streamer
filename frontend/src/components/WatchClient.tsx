'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Layers3, LoaderCircle } from 'lucide-react';
import { api, ApiError, bytes, type MediaInfo } from '@/lib/api';
import { useSwarm } from '@/lib/websocket';
import SwarmMetrics from './SwarmMetrics';
import VideoPlayer from './VideoPlayer';
import StreamDiagnostics from './StreamDiagnostics';

export default function WatchClient({ id }: { id: string }) {
  const { torrents, connected, loaded } = useSwarm(); const torrent = torrents.find(item => item.infoHash === id);
  const [media, setMedia] = useState<MediaInfo | null>(null); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [waitingForHeader, setWaitingForHeader] = useState(false);
  const ready = !!torrent?.fileName && !torrent.error && torrent.initialBufferReady;
  const buffering = !!torrent?.fileName && !torrent.error && (!torrent.initialBufferReady || waitingForHeader);
  useEffect(() => {
    setMedia(null); setError(''); setWaitingForHeader(false);
    if (!ready) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const info = await api<MediaInfo>(`/api/media/${id}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setWaitingForHeader(false); setMedia(info); }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === 'INITIAL_BUFFER_PENDING') {
          setWaitingForHeader(true); timer = setTimeout(() => void load(), 3000);
        } else setError((error as Error).message);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, ready, attempt]);
  return <div className="watch-page"><header className="watch-header"><Link className="brand" href="/"><span className="brand-mark"><Layers3 size={25} /></span>lumora<span className="brand-dot">.</span></Link><Link className="secondary compact" href="/"><ArrowLeft size={16} />All streams</Link></header>
    <main><div className="eyebrow mint">THE SCREEN IS YOURS</div><h1 className={media ? 'sr-only' : undefined}>{torrent?.name ?? 'Your streaming room'}</h1>{!media && <p className="watch-subtitle">{torrent?.fileName}{torrent?.fileSize ? ` · ${bytes(torrent.fileSize)}` : ''}</p>}
    {torrent && media && ready ? <VideoPlayer torrent={torrent} media={media} /> : <div className="player-placeholder panel">
      {error || torrent?.error ? <><h2>Unable to prepare playback</h2><p className="error" role="alert">{error || torrent?.error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></> : !torrent && loaded ? <><h2>{connected ? 'This stream is not active' : 'The engine is offline'}</h2><p>{connected ? 'Add the original torrent on the dashboard to restore playback.' : 'Start the backend, then return to your stream.'}</p><Link className="primary" href="/">Back to streams</Link></> : <><LoaderCircle className="spin mint" size={36} /><h2>{buffering ? 'Buffering initial pieces...' : ready ? 'Preparing your video' : 'Finding the swarm'}</h2><p role="status">{buffering ? 'Waiting for swarm to provide initial video header...' : ready ? 'Reading container headers and checking media tracks…' : 'Waiting for torrent metadata and peers…'}</p>{buffering && torrent && <p>{bytes(torrent.initialBufferBytes ?? 0)} / {bytes(torrent.initialBufferTargetBytes ?? 0)} verified</p>}</>}
    </div>}
    {media && <div className="media-info"><span>Source: {media.width} × {media.height}</span><span>{media.videoCodec.toUpperCase()} video</span><span>{media.audioCodec?.toUpperCase() ?? 'No audio'}</span><span>Choose playback quality in player settings</span></div>}
    <details className="watch-connection"><summary>Connection &amp; transfer details</summary><SwarmMetrics torrents={torrent ? [torrent] : []} connected={connected} />
    {torrent && <StreamDiagnostics torrent={torrent} />}</details>
    </main></div>;
}
