'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bookmark, History } from 'lucide-react';
import { api, time } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { readLocalLibrary } from '@/lib/local-library';
interface Entry { info_hash: string; name: string; position: number; duration: number; bookmarked: boolean }
export default function LibraryPanel({ bookmarks = false }: { bookmarks?: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]); const [message, setMessage] = useState('Your watches are saved on this device.');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const local = readLocalLibrary(); if (alive) setEntries(local);
      if (!supabase) return;
      const { data } = await supabase.auth.getSession();
      if (!data.session) { if (alive) setMessage('Saved on this device. Sign in to also sync your library.'); return; }
      try {
        const result = await api<Entry[]>('/api/library', { headers: { Authorization: `Bearer ${data.session.access_token}` } });
        if (alive) { setEntries([...new Map([...result, ...local].map(item => [item.info_hash, item])).values()]); setMessage('Your saved watches will appear here.'); }
      } catch (error) { if (alive) setMessage((error as Error).message); }
    };
    const refresh = () => void load();
    void load(); const subscription = supabase?.auth.onAuthStateChange(() => { setTimeout(refresh, 0); });
    window.addEventListener('lumora-library', refresh); window.addEventListener('storage', refresh);
    return () => { alive = false; subscription?.data.subscription.unsubscribe(); window.removeEventListener('lumora-library', refresh); window.removeEventListener('storage', refresh); };
  }, []);
  const visible = entries.filter(entry => !bookmarks || entry.bookmarked);
  return <section className="panel library"><h2>{bookmarks ? 'Bookmarks' : 'Watch history'}</h2>{!visible.length ? <div className="empty-state">{bookmarks ? <Bookmark size={30} /> : <History size={30} />}<h3>{bookmarks ? 'Keep the good ones close' : 'Pick up where you left off'}</h3><p>{message}</p></div> : visible.map(entry => <Link className="library-row" key={entry.info_hash} href={`/watch/${entry.info_hash}`}><span>{entry.name}</span><small>{time(entry.position)} / {time(entry.duration)}</small>{entry.bookmarked && <Bookmark size={16} />}</Link>)}</section>;
}
