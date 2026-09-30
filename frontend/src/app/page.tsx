'use client';
import { useState } from 'react';
import { Activity, Bookmark, CircleHelp, Film, History, Layers3, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import TorrentUploader from '@/components/TorrentUploader';
import StreamCard from '@/components/StreamCard';
import SwarmMetrics from '@/components/SwarmMetrics';
import AccountPanel from '@/components/AccountPanel';
import LibraryPanel from '@/components/LibraryPanel';
import { useSwarm } from '@/lib/websocket';
import { api } from '@/lib/api';
import { API } from '@/lib/api';

const hosted = API.startsWith('https://');

export default function Dashboard() {
  const { torrents, connected, loaded } = useSwarm();
  const [tab, setTab] = useState('streams'); const [notice, setNotice] = useState(''); const [help, setHelp] = useState(false);
  const [removing, setRemoving] = useState<string[]>([]);
  async function remove(hash: string) {
    if (removing.includes(hash)) return;
    setRemoving(previous => [...previous, hash]); setNotice('Removing stream and deleting its downloaded data…');
    try { await api(`/api/torrents/${hash}`, { method: 'DELETE' }); setNotice('Stream removed. Its downloaded data has been deleted.'); }
    catch (error) { setNotice((error as Error).message); }
    finally { setRemoving(previous => previous.filter(value => value !== hash)); }
  }
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/"><span className="brand-mark"><Layers3 size={25} /></span>lumora<span className="brand-dot">.</span></a>
      <div className="sidebar-label">YOUR SPACE</div><nav aria-label="Main navigation">
        <button className={tab === 'streams' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('streams')}><Radio size={18} />Streams<span className="nav-count">{torrents.length}</span></button>
        <button className={tab === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('history')}><History size={18} />Watch history</button>
        <button className={tab === 'bookmarks' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('bookmarks')}><Bookmark size={18} />Bookmarks</button>
      </nav><div className="sidebar-bottom"><div className="quality-note"><ShieldCheck size={20} /><strong>Every pixel. Original.</strong><p>Choose Original to keep your video untouched, from the swarm to your screen.</p><span>ORIGINAL BY DEFAULT</span></div><button className="nav-item" onClick={() => setHelp(!help)}><CircleHelp size={18} />How it works</button><div className="version">LUMORA ENGINE <span>v1.0</span></div></div>
    </aside>
    <div className="main-column"><header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span>{tab === 'streams' ? 'Streams' : tab === 'history' ? 'Watch history' : 'Bookmarks'}</div><div className="topbar-right"><span className="connection"><i className={`status-dot ${connected ? 'live' : ''}`} />{connected ? 'Engine connected' : 'Engine offline'}</span><AccountPanel /></div></header>
      <main className="dashboard"><div className="page-heading"><div className="eyebrow mint"><span className="small-line" />YOUR PERSONAL STREAMING ROOM</div><h1>Less waiting.<br className="mobile-only" /> More watching<span className="mint">.</span></h1><p>Bring a torrent. Take a seat. Let the swarm do the rest.</p></div>
      <SwarmMetrics torrents={torrents} connected={connected} />
      {loaded && !connected && <div className="panel offline-banner" role="alert"><strong>The streaming engine is offline</strong><p>{hosted ? 'The hosted engine may be waking up. This page will reconnect automatically; on Render Free, downloads are lost when the service sleeps or restarts.' : 'Run Start-Lumora.ps1 in your Lumora folder. This page will reconnect automatically; saved torrents return when the engine starts.'}</p></div>}
      {tab === 'streams' ? <><div className="ingest-grid"><TorrentUploader onAdded={torrent => setNotice(`${torrent.name}: added to your streams.`)} /><aside className="feature-panel"><div className="orbit-art" aria-hidden="true"><div className="orbit one" /><div className="orbit two" /><div className="orbit three" /><div className="orbit-core"><PlayIcon /></div><span className="orbit-node n1" /><span className="orbit-node n2" /><span className="orbit-node n3" /></div><div><span className="eyebrow mint">POWERED BY THE SWARM</span><h2>Big files.<br />Small wait.</h2><p>Playback pieces move to the front of the queue. Original video quality comes along for the ride.</p><span className="feature-foot"><Sparkles size={14} />Smart buffering · Lossless video</span></div></aside></div>
      <section className="active-section"><div className="section-heading"><h2>Active streams <span className="count-pill">{torrents.length}</span></h2><span className="live-label"><Activity size={14} />{connected ? 'LIVE SWARM ACTIVITY' : 'AWAITING CONNECTION'}</span></div>
      {torrents.length ? <div className="stream-list">{torrents.map(torrent => <StreamCard key={torrent.infoHash} torrent={torrent} removing={removing.includes(torrent.infoHash)} onRemove={() => void remove(torrent.infoHash)} />)}</div> : <div className="empty-state panel"><div className="empty-icon"><Film size={26} /></div><h3>{!loaded ? 'Connecting to your engine…' : 'Your screen is ready'}</h3><p>Add a magnet link or torrent file above to start your first stream.</p><span className="empty-meta">MP4 · MKV · AVI · WEBM</span></div>}</section></> : <LibraryPanel bookmarks={tab === 'bookmarks'} />}
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
      {help && <section className="panel help-panel"><h2>A shorter path to playback</h2><p>Lumora discovers peers, prioritizes the selected video’s headers and the next 75 MB, and streams verified pieces as they arrive. MP4 with H.264/AAC plays directly. Other supported containers are repackaged with the video preserved; incompatible audio is converted to AAC.</p><p>Startup and buffering depend on peer availability and media bitrate. Your local engine shares downloaded pieces with the swarm. Use media you have permission to share.</p></section>}
      <footer><span><i className={`status-dot ${connected ? 'live' : ''}`} />{connected ? 'Your streaming engine is ready' : hosted ? 'Waiting for the hosted engine' : 'Start the backend to connect'}</span><span>Built for the way you watch.</span></footer>
      </main>
    </div>
  </div>;
}
function PlayIcon() { return <svg width="28" height="32" viewBox="0 0 28 32" fill="none"><path d="M6 3L25 16L6 29V3Z" fill="currentColor" /></svg>; }
