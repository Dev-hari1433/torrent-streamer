'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, json } from './api';
import { supabase } from './supabase';
import { readLocalLibrary, saveLocalWatch } from './local-library';
export function useWatchMemory(hash: string, name: string, duration: number, position: number, videoRef: RefObject<HTMLVideoElement | null>) {
  const [resume, setResume] = useState(0); const [saved, setSaved] = useState(false); const savedRef = useRef(false);
  const latest = useRef({ position, name }); latest.current = { position, name };
  const save = useCallback(async (at: number) => {
    const entry = { info_hash: hash, name: latest.current.name, position: at, duration, bookmarked: savedRef.current };
    saveLocalWatch(entry);
    if (!supabase) return;
    const { data } = await supabase.auth.getSession(); if (!data.session) return;
    await api(`/api/library/${hash}`, { ...json({ name: entry.name, position: at, duration, bookmarked: savedRef.current }), method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` } });
  }, [hash, duration]);
  useEffect(() => {
    let alive = true; const entry = readLocalLibrary().find(item => item.info_hash === hash);
    if (entry) { savedRef.current = entry.bookmarked; setSaved(entry.bookmarked); if (entry.position > 5 && entry.position < duration - 10) setResume(entry.position); }
    if (supabase && !entry) void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const library = await api<Array<{ info_hash: string; position: number; bookmarked: boolean }>>('/api/library', { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      const found = library.find(item => item.info_hash === hash);
      if (found && alive) { savedRef.current = found.bookmarked; setSaved(found.bookmarked); if (found.position > 5 && found.position < duration - 10) setResume(found.position); }
    }).catch(() => undefined);
    const video = videoRef.current!;
    const persist = () => { if (latest.current.position > 0) void save(latest.current.position).catch(() => undefined); };
    const interval = setInterval(() => { if (!video.paused) persist(); }, 10000);
    const visibility = () => { if (document.hidden) persist(); };
    video.addEventListener('pause', persist); document.addEventListener('visibilitychange', visibility);
    return () => { alive = false; clearInterval(interval); video.removeEventListener('pause', persist); document.removeEventListener('visibilitychange', visibility); persist(); };
  }, [hash, duration, save, videoRef]);
  return { resume, clearResume: () => setResume(0), saved, toggleBookmark: () => { savedRef.current = !savedRef.current; setSaved(savedRef.current); void save(position).catch(() => undefined); } };
}
