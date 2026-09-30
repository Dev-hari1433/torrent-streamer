'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bookmark, Check, ChevronLeft, Captions, Expand, Gauge, Keyboard, LoaderCircle, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Settings2, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react';
import Link from 'next/link';
import { bytes, time, type MediaInfo, type TorrentState } from '@/lib/api';
import { useMediaPlayback } from '@/lib/useMediaPlayback';
import { useWatchMemory } from '@/lib/useWatchMemory';
import { parseCaptions, type Caption } from '@/lib/captions';

export default function CinemaPlayer({ torrent, media }: { torrent: TorrentState; media: MediaInfo }) {
  const playback = useMediaPlayback(torrent.infoHash, torrent.fileSize, media); const { state, videoRef, base } = playback;
  const memory = useWatchMemory(torrent.infoHash, torrent.name, media.duration, state.position, videoRef);
  const surface = useRef<HTMLDivElement>(null); const captionInput = useRef<HTMLInputElement>(null);
  const captionTrack = useRef<TextTrack | null>(null); const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [controls, setControls] = useState(true); const [panel, setPanel] = useState<'settings' | 'captions' | 'shortcuts' | null>(null);
  const [fullscreen, setFullscreen] = useState(false); const [pipSupported, setPipSupported] = useState(false);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain'); const [notice, setNotice] = useState('');
  const [scrub, setScrub] = useState<number | null>(null); const [hover, setHover] = useState<number | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]); const [captionName, setCaptionName] = useState(''); const [captionsOn, setCaptionsOn] = useState(false);
  const position = scrub ?? state.position; const progress = media.duration ? position / media.duration * 100 : 0;
  const busy = ['loading', 'buffering', 'seeking'].includes(state.status);
  const original = playback.quality === 'original';
  const qualityLabel = original ? `Original · ${media.height}p` : `${playback.quality}p`;
  const title = torrent.name.replace(/\.(mkv|mp4|avi|webm)$/i, '').replace(/_/g, ' ');
  function reveal() { setControls(true); clearTimeout(hideTimer.current); }
  function move() { reveal(); if (state.playing && !panel && scrub === null) hideTimer.current = setTimeout(() => setControls(false), 3000); }
  useEffect(() => {
    clearTimeout(hideTimer.current);
    if (controls && state.playing && !panel && scrub === null) hideTimer.current = setTimeout(() => setControls(false), 3000);
    return () => clearTimeout(hideTimer.current);
  }, [controls, state.playing, panel, scrub]);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === surface.current);
    document.addEventListener('fullscreenchange', sync); setPipSupported(!!document.pictureInPictureEnabled);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const sourceBase = base.current;
  useEffect(() => {
    const video = videoRef.current; if (!video || !captions.length) return;
    const track = captionTrack.current ?? video.addTextTrack('subtitles', 'Local subtitles', 'en'); captionTrack.current = track;
    while (track.cues?.length) track.removeCue(track.cues[0]);
    for (const caption of captions) if (caption.end > sourceBase) track.addCue(new VTTCue(Math.max(0, caption.start - sourceBase), caption.end - sourceBase, caption.text));
    track.mode = captionsOn ? 'showing' : 'hidden';
  }, [captions, captionsOn, sourceBase, videoRef]);
  async function toggleFullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await surface.current?.requestFullscreen(); }
    catch { setNotice('Fullscreen is unavailable in this browser window.'); }
  }
  async function togglePip() {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await videoRef.current?.requestPictureInPicture(); }
    catch { setNotice('Start playback before opening picture-in-picture.'); }
  }
  async function loadCaptions(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 ** 2) { setNotice('Choose a subtitle file smaller than 2 MB.'); return; }
    const cues = parseCaptions(await file.text());
    if (!cues.length) { setNotice('No readable subtitle cues found. Choose an SRT or WebVTT file.'); return; }
    setCaptions(cues); setCaptionName(file.name); setCaptionsOn(true); setPanel(null);
  }
  const togglePlay = () => { memory.clearResume(); playback.togglePlay(); };
  const commitSeek = (value: number) => { setScrub(null); memory.clearResume(); void playback.seek(value, state.playing); };
  function shortcuts(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.target instanceof HTMLButtonElement && [' ', 'Enter'].includes(event.key)) return;
    const actions: Record<string, () => void> = {
      ' ': togglePlay, k: togglePlay,
      ArrowLeft: () => void playback.seek(state.position - 10, state.playing), j: () => void playback.seek(state.position - 10, state.playing),
      ArrowRight: () => void playback.seek(state.position + 10, state.playing), l: () => void playback.seek(state.position + 10, state.playing),
      ArrowUp: () => playback.setVolume(state.volume + 0.05), ArrowDown: () => playback.setVolume(state.volume - 0.05),
      m: playback.toggleMute, f: () => void toggleFullscreen(), c: () => setCaptionsOn(value => !value), Escape: () => setPanel(null), '?': () => setPanel('shortcuts'),
    };
    const action = actions[event.key]; if (action) { event.preventDefault(); action(); reveal(); }
  }
  const togglePanel = (value: typeof panel) => { setPanel(panel === value ? null : value); reveal(); };
  return <div className="cinema-wrapper">
    <div ref={surface} className={`cinema ${controls || !state.playing || panel ? 'controls-visible' : 'controls-hidden'} ${busy ? 'is-buffering' : ''}`} role="region" aria-label="Video player" tabIndex={0} onKeyDown={shortcuts} onPointerMove={move} onFocusCapture={reveal}>
      <video ref={videoRef} playsInline preload="auto" style={{ objectFit: fit }} aria-label={torrent.name} onClick={() => { togglePlay(); reveal(); }} onDoubleClick={() => void toggleFullscreen()} />
      {!state.hasFrame && <div className="cinema-backdrop"><div className="cinema-glow" /><span className="cinema-watermark">LUMORA</span></div>}
      <div className="cinema-top cinema-chrome"><Link href="/" className="cinema-icon" aria-label="Back to streams"><ChevronLeft size={26} /></Link><div><span className="cinema-kicker">YOUR SCREEN. YOUR MOMENT.</span><h2 title={title}>{title}</h2></div><button className="cinema-quality" onClick={() => togglePanel('settings')} aria-label={`Video quality: ${qualityLabel}`}><ShieldCheck size={14} />{original ? 'ORIGINAL' : `${playback.quality}p`}</button></div>
      {busy && <div className="cinema-center" role="status"><span className="cinema-spinner"><LoaderCircle size={34} /></span><strong>{state.status === 'seeking' ? 'Finding your moment' : state.hasFrame ? 'Buffering your video' : 'Preparing your screen'}</strong><small>{state.error || (torrent.downloadSpeed ? `${bytes(torrent.downloadSpeed)}/s · ${torrent.numPeers} connected peers` : 'Waiting for the next verified pieces')}</small></div>}
      {!busy && !state.playing && state.status !== 'error' && !memory.resume && <button className="cinema-center-play" onClick={() => { if (state.status === 'ended') void playback.seek(0); else void playback.play(); }} aria-label={state.status === 'ended' ? 'Replay video' : 'Play video'}>{state.status === 'ended' ? <RotateCcw size={34} /> : <Play size={36} fill="currentColor" />}</button>}
      {memory.resume > 0 && !state.playing && !busy && <div className="cinema-resume"><span>WELCOME BACK</span><h3>Pick up where you left off</h3><button className="primary" onClick={() => { void playback.seek(memory.resume); memory.clearResume(); }}><Play size={17} fill="currentColor" />Resume at {time(memory.resume)}</button><button className="cinema-text-button" onClick={() => { memory.clearResume(); void playback.seek(0); }}>Start from the beginning</button></div>}
      {state.status === 'error' && <div className="cinema-error" role="alert"><h3>Let’s reconnect your video</h3><p>{state.error}</p><button className="primary" onClick={playback.retry}><RotateCcw size={16} />Try again</button></div>}
      {panel && <div className="cinema-menu" role="dialog" aria-label={panel === 'settings' ? 'Playback settings' : panel === 'captions' ? 'Subtitle settings' : 'Keyboard shortcuts'}><div className="cinema-menu-heading"><strong>{panel === 'settings' ? 'Your playback' : panel === 'captions' ? 'Subtitles' : 'Keyboard shortcuts'}</strong><button className="cinema-icon" onClick={() => setPanel(null)} aria-label="Close settings"><X size={19} /></button></div>
        {panel === 'settings' ? <>
          <label className="cinema-menu-label" htmlFor="video-quality">Video quality</label>
          <select id="video-quality" className="cinema-quality-select" value={playback.quality} onChange={event => playback.changeQuality(event.target.value as typeof playback.quality)}>
            {(media.qualities ?? ['original']).map(quality => <option key={quality} value={quality}>{quality === 'original' ? `Original · ${media.height}p` : `${quality}p`}</option>)}
          </select>
          <p className="cinema-menu-note">{original ? 'Original keeps the source video untouched.' : 'Converted on this computer. Switching keeps your place.'} Lower quality reduces player bandwidth; torrent download size stays the same.</p>
          <span className="cinema-menu-label">Playback speed</span><div className="cinema-speed-options">{[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <button key={rate} aria-pressed={state.rate === rate} onClick={() => playback.setRate(rate)}>{rate}×</button>)}</div><button className="cinema-menu-row" onClick={() => setFit(fit === 'contain' ? 'cover' : 'contain')}><Expand size={17} />Screen size<span>{fit === 'contain' ? 'Fit' : 'Fill'}</span></button>
        </> : panel === 'captions' ? <><button className="cinema-menu-row" onClick={() => setCaptionsOn(false)}>Off{!captionsOn && <Check size={16} />}</button>{captionName && <button className="cinema-menu-row" onClick={() => setCaptionsOn(true)}>{captionName}{captionsOn && <Check size={16} />}</button>}<button className="secondary compact" onClick={() => captionInput.current?.click()}>Load subtitle file</button><p className="cinema-menu-note">SRT or WebVTT · stays on this device</p></> : <dl className="cinema-shortcuts"><dt>Play / pause</dt><dd>Space / K</dd><dt>Back / forward 10s</dt><dd>← / →</dd><dt>Volume</dt><dd>↑ / ↓</dd><dt>Mute</dt><dd>M</dd><dt>Fullscreen</dt><dd>F</dd><dt>Subtitles</dt><dd>C</dd><dt>Close menu</dt><dd>Esc</dd></dl>}
      </div>}
      <input ref={captionInput} type="file" accept=".srt,.vtt,text/vtt" className="sr-only" aria-label="Load subtitles" onChange={event => void loadCaptions(event.target.files?.[0])} />
      <div className="cinema-bottom cinema-chrome">
        <div className="cinema-timeline" onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * media.duration); }} onPointerLeave={() => setHover(null)}>
          <div className="cinema-track"><span className="cinema-track-downloaded" style={{ width: `${torrent.progress * 100}%` }} />{state.buffered.map((range, i) => <span key={i} className="cinema-track-buffered" style={{ left: `${range.start / Math.max(1, media.duration) * 100}%`, width: `${(range.end - range.start) / Math.max(1, media.duration) * 100}%` }} />)}<span className="cinema-track-played" style={{ width: `${progress}%` }} /></div>
          <input aria-label="Seek through video" aria-valuetext={`${time(position)} of ${time(media.duration)}`} type="range" min={0} max={media.duration || 1} step={0.1} value={Math.min(position, media.duration || 1)} disabled={!media.duration} onChange={event => setScrub(Number(event.target.value))} onPointerUp={event => commitSeek(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSeek(Number(event.currentTarget.value)); }} onPointerCancel={() => setScrub(null)} />
          {hover !== null && <span className="cinema-seek-time" style={{ left: `${Math.min(95, Math.max(5, hover / Math.max(1, media.duration) * 100))}%` }}>{time(hover)}</span>}
        </div>
        <div className="cinema-controls"><button className="cinema-icon main-play" onClick={togglePlay} aria-label={state.playing ? 'Pause' : 'Play'} title="Play / pause (Space)">{state.playing ? <Pause size={27} fill="currentColor" /> : <Play size={27} fill="currentColor" />}</button><button className="cinema-icon cinema-skip" onClick={() => void playback.seek(state.position - 10, state.playing)} aria-label="Back 10 seconds" title="Back 10 seconds"><RotateCcw size={27} /><small>10</small></button><button className="cinema-icon cinema-skip" onClick={() => void playback.seek(state.position + 10, state.playing)} aria-label="Forward 10 seconds" title="Forward 10 seconds"><RotateCw size={27} /><small>10</small></button>
          <div className="cinema-volume"><button className="cinema-icon" onClick={playback.toggleMute} aria-label={state.muted ? 'Unmute' : 'Mute'} title="Mute (M)">{state.muted || !state.volume ? <VolumeX size={24} /> : <Volume2 size={24} />}</button><input aria-label="Volume" type="range" min={0} max={1} step={0.05} value={state.muted ? 0 : state.volume} onChange={event => playback.setVolume(Number(event.target.value))} /></div>
          <span className="cinema-clock">{time(position)}<span> / {time(media.duration)}</span></span><span className="cinema-controls-spacer" />
          <button className={`cinema-icon ${captionsOn ? 'is-active' : ''}`} onClick={() => togglePanel('captions')} aria-label="Subtitles" aria-expanded={panel === 'captions'} title="Subtitles"><Captions size={24} /></button><button className={`cinema-icon ${panel === 'settings' ? 'is-active' : ''}`} onClick={() => togglePanel('settings')} aria-label="Playback settings" aria-expanded={panel === 'settings'} title="Playback settings"><Settings2 size={23} /></button>
          {pipSupported && <button className="cinema-icon cinema-pip" onClick={() => void togglePip()} aria-label="Picture in picture" disabled={!state.hasFrame} title="Picture in picture"><PictureInPicture2 size={24} /></button>}<button className="cinema-icon" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title="Fullscreen (F)">{fullscreen ? <Minimize size={24} /> : <Maximize size={24} />}</button>
        </div>
      </div>
    </div>
    <div className="cinema-footer"><div className="cinema-stream-health"><span className={`status-dot ${state.status !== 'error' ? 'live' : ''}`} /><span>{busy ? 'Building your buffer' : state.playing ? 'Enjoy the moment' : 'Ready when you are'}</span><span className="cinema-health-detail">{Math.round(state.bufferedSeconds)}s buffered · {original ? media.videoCodec.toUpperCase() : 'H264'} · {qualityLabel}</span></div><button className="cinema-footer-button" aria-pressed={memory.saved} onClick={memory.toggleBookmark}><Bookmark size={16} fill={memory.saved ? 'currentColor' : 'none'} />{memory.saved ? 'Saved' : 'Save'}</button><button className="cinema-footer-button" onClick={() => togglePanel('shortcuts')} aria-label="Show keyboard shortcuts"><Keyboard size={17} /></button></div>
    {notice && <div className="cinema-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss player message"><X size={16} /></button></div>}
    <details className="cinema-stats"><summary><Gauge size={14} /> Playback details</summary><span>{state.firstFrameMs === null ? 'Press play to measure first frame' : `Play to frame: ${(state.firstFrameMs / 1000).toFixed(2)}s`}</span><span>{!original ? `${qualityLabel} · live conversion` : media.mode === 'direct' ? 'Direct playback' : 'Original video · live container remux'}</span><span>{bytes(torrent.downloadSpeed)}/s · {torrent.numPeers} peers</span><button className="cinema-text-button" onClick={playback.retry}>Reconnect stream</button></details>
  </div>;
}
