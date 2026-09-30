'use client';
import { useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, FileUp, Link2, LoaderCircle, Plus } from 'lucide-react';
import { api, json, type TorrentState } from '@/lib/api';

export default function TorrentUploader({ onAdded }: { onAdded: (torrent: TorrentState) => void }) {
  const [magnet, setMagnet] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true);
    try { const torrent = await api<TorrentState>('/api/magnet', json({ magnet: magnet.trim() })); setMagnet(''); onAdded(torrent); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file || busy) return;
    if (!/\.torrent$/i.test(file.name) || file.size > 50 * 1024 * 1024) { setError('Choose a .torrent file smaller than 50 MB.'); return; }
    setError(''); setBusy(true);
    try { const body = new FormData(); body.append('file', file); onAdded(await api<TorrentState>('/api/upload', { method: 'POST', body })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <section className="ingest panel">
    <div className="section-heading"><span className="icon-box"><Plus size={20} /></span><div><h2>Start a stream</h2><p>Your next watch starts here.</p></div><span className="eyebrow ml-auto">01 / INGEST</span></div>
    <form onSubmit={submit} className="magnet-form"><label className="sr-only" htmlFor="magnet">Magnet link</label><Link2 size={20} /><input id="magnet" value={magnet} onChange={event => setMagnet(event.target.value)} placeholder="Paste a magnet link…" required disabled={busy} autoComplete="off" /><button className="primary" disabled={busy || !magnet.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <>Start stream <ArrowUpRight size={18} /></>}</button></form>
    <div className="or-divider"><span />or add a file<span /></div>
    <button className={`drop-zone ${dragging ? 'dragging' : ''}`} disabled={busy} onClick={() => input.current?.click()}
      onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
      <FileUp size={28} /><span><strong>Drop a torrent file here</strong><small>or click to browse · .torrent up to 50 MB</small></span><span className="file-chip">.torrent</span>
    </button>
    <input ref={input} type="file" accept=".torrent,application/x-bittorrent" className="sr-only" tabIndex={-1} aria-label="Choose torrent file" onChange={event => void upload(event.target.files?.[0])} />
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
