'use client';
import { useEffect, useState } from 'react';
import { API, api, type TorrentState } from './api';

export function useSwarm() {
  const [torrents, setTorrents] = useState<TorrentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false; let socket: WebSocket; let attempt = 0; let timer: ReturnType<typeof setTimeout>; let lastSnapshot = 0; let polling = false;
    const controller = new AbortController();
    const poll = async () => {
      if (disposed || polling || (socket?.readyState === WebSocket.OPEN && Date.now() - lastSnapshot < 4000)) return;
      polling = true;
      try {
        const items = await api<TorrentState[]>('/api/active', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!disposed) { setTorrents(items); setConnected(true); setLoaded(true); }
      } catch { if (!disposed) { setLoaded(true); setConnected(false); } }
      finally { polling = false; }
    };
    void poll(); const fallback = setInterval(() => void poll(), 3000);
    const connect = () => {
      const url = new URL('/telemetry', API); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => { attempt = 0; setConnected(true); };
      socket.onmessage = event => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; torrents?: TorrentState[] };
          if (payload.type === 'snapshot' && Array.isArray(payload.torrents)) { lastSnapshot = Date.now(); setTorrents(payload.torrents); setLoaded(true); }
        } catch { /* Ignore malformed frames; a later snapshot replaces state. */ }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false); timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000) + Math.random() * 300);
      };
    };
    connect();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); clearInterval(fallback); socket?.close(); };
  }, []);
  return { torrents, connected, loaded };
}
