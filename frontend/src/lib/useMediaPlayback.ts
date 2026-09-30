'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API, api, json, type MediaInfo, type PlaybackQuality } from './api';
import { bufferedRanges, bufferAhead, containsTime, type BufferedRange } from './player-utils';
import { attachRemuxSource } from './remux-source';

type Status = 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'seeking' | 'ended' | 'error';
const initial = { status: 'loading' as Status, position: 0, buffered: [] as BufferedRange[], bufferedSeconds: 0,
  playing: false, hasFrame: false, error: '', volume: 1, muted: false, rate: 1, firstFrameMs: null as number | null };
export function useMediaPlayback(hash: string, fileSize: number, media: MediaInfo) {
  const videoRef = useRef<HTMLVideoElement>(null); const base = useRef(0); const session = useRef('');
  const mounted = useRef(false); const sequence = useRef(0); const controller = useRef<AbortController | null>(null);
  const retries = useRef(0); const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedAt = useRef<number | null>(null); const seekRef = useRef<(at: number, play?: boolean, force?: boolean) => Promise<void>>(async () => {});
  const [state, setState] = useState(initial);
  const [quality, setQuality] = useState<PlaybackQuality>('original');
  const qualityRef = useRef<PlaybackQuality>('original');
  const detachSource = useRef<(() => void) | null>(null);
  const sourceError = useRef<(error: Error) => void>(() => {});
  const streamUrl = useCallback((start = 0) => `${API}/api/stream/${hash}?start=${start}&quality=${qualityRef.current}`, [hash]);
  const loadSource = useCallback((start = 0) => {
    const video = videoRef.current; if (!video) return;
    detachSource.current?.(); detachSource.current = null;
    if ((qualityRef.current !== 'original' || media.mode === 'remux' && media.videoCodec === 'h264') && typeof MediaSource !== 'undefined') {
      detachSource.current = attachRemuxSource(video, streamUrl(start), Math.max(0, media.duration - start), !!media.audioCodec, error => sourceError.current(error));
    } else video.src = streamUrl(start);
    video.load();
  }, [streamUrl, media.mode, media.videoCodec, media.audioCodec, media.duration]);
  const report = useCallback((at?: number) => {
    const video = videoRef.current;
    if (!video || !session.current) return;
    const position = at ?? base.current + video.currentTime;
    const ahead = bufferAhead(bufferedRanges(video.buffered, base.current), position);
    void api(`/api/torrents/${hash}/playhead`, { ...json({ sessionId: session.current,
      byteOffset: media.duration ? Math.min(fileSize - 1, Math.floor(position / media.duration * fileSize)) : 0,
      bufferedSeconds: ahead / (video.playbackRate || 1) }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }, [hash, fileSize, media.duration]);
  const play = useCallback(async () => {
    const video = videoRef.current; if (!video) return;
    if (startedAt.current === null && !video.currentTime) startedAt.current = performance.now();
    try { await video.play(); }
    catch (error) { if (mounted.current && (error as Error).name === 'NotAllowedError') setState(old => ({ ...old, status: 'ready', playing: false })); }
  }, []);
  const seek = useCallback(async (at: number, shouldPlay = true, force = false, retainPosition = false) => {
    const video = videoRef.current; if (!video) return;
    const target = Math.min(Math.max(0, at), Math.max(0, media.duration - 0.1));
    const currentSequence = ++sequence.current;
    controller.current?.abort(); clearTimeout(retryTimer.current);
    const canUseBuffer = !force && !video.error && containsTime(bufferedRanges(video.buffered, base.current), target)
      && containsTime(bufferedRanges(video.seekable, base.current), target);
    setState(old => ({ ...old, position: target, status: 'seeking', error: '' }));
    report(target);
    if (media.mode === 'direct' && qualityRef.current === 'original' || canUseBuffer) {
      base.current = media.mode === 'direct' && qualityRef.current === 'original' ? 0 : base.current;
      if (force || video.error || !video.readyState) {
        const onReady = () => { if (mounted.current && sequence.current === currentSequence) video.currentTime = target; };
        video.addEventListener('loadedmetadata', onReady, { once: true }); loadSource();
      } else video.currentTime = Math.max(0, target - base.current);
    } else {
      video.pause();
      const abort = new AbortController(); controller.current = abort;
      try {
        // Starting at zero needs no extra round-trip or keyframe worker.
        const point = target === 0 || qualityRef.current !== 'original' ? { start: target } : await api<{ start: number }>(`/api/media/${hash}/seek?time=${target}`, { signal: abort.signal });
        if (!mounted.current || abort.signal.aborted || sequence.current !== currentSequence) return;
        base.current = point.start;
        if (retainPosition && target > point.start) video.addEventListener('loadedmetadata', () => {
          if (mounted.current && sequence.current === currentSequence) video.currentTime = target - point.start;
        }, { once: true });
        loadSource(point.start);
        setState(old => ({ ...old, position: point.start, buffered: [], bufferedSeconds: 0 }));
      } catch (error) {
        if (mounted.current && !abort.signal.aborted) setState(old => ({ ...old, status: 'error', error: (error as Error).message }));
        return;
      }
    }
    if (shouldPlay) await play();
  }, [hash, media.duration, media.mode, report, play, loadSource]);
  seekRef.current = seek;
  const retry = useCallback(() => {
    retries.current = 0; const video = videoRef.current;
    if (video) void seek(base.current + video.currentTime, true, true);
  }, [seek]);
  const changeQuality = useCallback((next: PlaybackQuality) => {
    const video = videoRef.current;
    if (!video || next === qualityRef.current || !(media.qualities ?? ['original']).includes(next)) return;
    const position = base.current + video.currentTime; const playing = !video.paused;
    qualityRef.current = next; setQuality(next);
    // Force a new representation; never reuse buffered frames of the previous quality.
    void seek(position, playing, true, true);
  }, [media.qualities, seek]);

  useEffect(() => {
    const video = videoRef.current!; mounted.current = true; base.current = 0; retries.current = 0;
    session.current = crypto.randomUUID(); const owner = session.current;
    setState(initial); let frameRequest = 0; let disposed = false; let stalledAt = 0; let lastProgressAt = 0;
    video.preload = 'auto'; startedAt.current = null;
    try {
      const settings = JSON.parse(localStorage.getItem('lumora.player.v1') ?? '{}');
      if (Number.isFinite(settings.volume)) video.volume = Math.max(0, Math.min(1, settings.volume));
      if ([0.5, 0.75, 1, 1.25, 1.5, 2].includes(settings.rate)) video.defaultPlaybackRate = video.playbackRate = settings.rate;
      video.muted = settings.muted === true;
    } catch { /* Use browser defaults. */ }
    const patch = (value: Partial<typeof initial>) => { if (!disposed) setState(old => ({ ...old, ...value })); };
    const progress = () => {
      const position = Math.min(media.duration || Infinity, base.current + video.currentTime);
      const buffered = bufferedRanges(video.buffered, base.current);
      patch({ position, buffered, bufferedSeconds: bufferAhead(buffered, position) });
      lastProgressAt = Date.now();
    };
    const playing = () => {
      stalledAt = 0; clearTimeout(retryTimer.current);
      patch({ status: 'playing', playing: true, error: '' });
      if (startedAt.current !== null) {
        const rendered = () => { if (startedAt.current !== null) { patch({ firstFrameMs: performance.now() - startedAt.current }); startedAt.current = null; } };
        if ('requestVideoFrameCallback' in video) frameRequest = video.requestVideoFrameCallback(rendered); else rendered();
      }
    };
    const ready = () => { patch({ hasFrame: true, error: '', status: video.paused ? 'ready' : 'playing' }); progress(); };
    const waiting = () => { stalledAt ||= Date.now(); patch({ status: 'buffering' }); };
    const pause = () => { patch({ playing: false }); setState(old => ({ ...old, status: ['seeking', 'error'].includes(old.status) ? old.status : 'paused' })); };
    const ended = () => {
      if (media.duration - (base.current + video.currentTime) > 2) { recover(); return; }
      patch({ playing: false, status: 'ended', position: media.duration });
    };
    const seeking = () => { patch({ status: 'seeking' }); };
    const seeked = () => { progress(); patch({ status: video.paused ? 'paused' : 'playing' }); };
    const preferences = () => {
      patch({ volume: video.volume, muted: video.muted, rate: video.playbackRate });
      try { localStorage.setItem('lumora.player.v1', JSON.stringify({ volume: video.volume, muted: video.muted, rate: video.playbackRate })); } catch { /* Optional. */ }
    };
    const recover = (cause?: Error) => {
      if (retries.current >= 3) { patch({ status: 'error', playing: false, error: 'Playback could not recover. Check the swarm connection or retry.' }); return; }
      const position = base.current + video.currentTime;
      retries.current++; patch({ status: 'buffering', error: cause?.message ?? 'Waiting for swarm to provide initial video header…' });
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => { if (!disposed) void seekRef.current(position, true, true); }, retries.current * 1500);
    };
    const error = () => {
      if (video.error?.code === 2 || video.error?.code === 4) recover();
      else patch({ status: 'error', playing: false, error: 'This video could not be decoded. Retry or use a browser that supports its codec.' });
    };
    const events: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [
      ['timeupdate', progress], ['progress', progress], ['loadeddata', ready], ['playing', playing], ['waiting', waiting],
      ['pause', pause], ['ended', ended], ['seeking', seeking], ['seeked', seeked], ['error', error], ['volumechange', preferences], ['ratechange', preferences],
    ];
    for (const [name, handler] of events) video.addEventListener(name, handler);
    sourceError.current = recover; loadSource();
    preferences(); report();
    const interval = setInterval(() => {
      report();
      if (Date.now() - lastProgressAt > 2000) progress();
      if (stalledAt && !video.paused && Date.now() - stalledAt > 12000) { stalledAt = Date.now(); recover(); }
    }, 3000);
    return () => {
      disposed = true; mounted.current = false; sequence.current++; controller.current?.abort();
      clearInterval(interval); clearTimeout(retryTimer.current);
      if (frameRequest) video.cancelVideoFrameCallback(frameRequest);
      detachSource.current?.(); detachSource.current = null;
      for (const [name, handler] of events) video.removeEventListener(name, handler);
      video.pause(); video.removeAttribute('src'); video.load();
      void api(`/api/torrents/${hash}/playhead/${owner}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
  }, [hash, media.duration, report, loadSource]);

  return { videoRef, state, base, play, seek, retry, quality, changeQuality,
    togglePlay: () => { const video = videoRef.current; if (video?.paused) void play(); else video?.pause(); },
    setVolume: (volume: number) => { const video = videoRef.current; if (video) { video.volume = Math.min(1, Math.max(0, volume)); video.muted = volume === 0; } },
    toggleMute: () => { const video = videoRef.current; if (video) video.muted = !video.muted; },
    setRate: (rate: number) => { if (videoRef.current) videoRef.current.defaultPlaybackRate = videoRef.current.playbackRate = rate; },
  };
}
