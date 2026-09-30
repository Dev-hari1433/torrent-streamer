/** Stream fragmented MP4 through MSE so native range probes cannot truncate a live response. */
export function attachRemuxSource(video: HTMLVideoElement, url: string, duration: number, hasAudio: boolean, fail: (error: Error) => void) {
  const source = new MediaSource(); const objectUrl = URL.createObjectURL(source);
  const controller = new AbortController(); const { signal } = controller;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortError = () => signal.reason ?? new DOMException('Playback cancelled', 'AbortError');
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(abortError()); };
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
  const update = (buffer: SourceBuffer, action: () => void) => new Promise<void>((resolve, reject) => {
    const clean = () => { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', error); signal.removeEventListener('abort', abort); };
    const done = () => { clean(); resolve(); };
    const error = () => { clean(); reject(new Error('The browser could not decode this media fragment.')); };
    const abort = () => { clean(); reject(abortError()); };
    buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', error, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); action(); } catch (cause) { clean(); reject(cause); }
  });
  const open = async () => {
    try {
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(response.status === 503 ? 'Waiting for swarm to provide initial video header…' : `Stream unavailable (${response.status}).`);
      reader = response.body.getReader();
      let initial = new Uint8Array(0); let codec: string | null = null;
      while (!codec) {
        const chunk = await reader.read(); if (chunk.done) throw new Error('The stream ended before its video header arrived.');
        const joined = new Uint8Array(initial.length + chunk.value.length); joined.set(initial); joined.set(chunk.value, initial.length); initial = joined;
        codec = avcCodecFromInit(initial);
        if (initial.length > 2 * 1024 ** 2) throw new Error('The stream did not provide a valid MP4 initialization segment.');
      }
      const mime = `video/mp4; codecs="${codec}${hasAudio ? ',mp4a.40.2' : ''}"`;
      if (!MediaSource.isTypeSupported(mime)) throw new Error('This browser does not support the original video codec.');
      signal.throwIfAborted();
      const buffer = source.addSourceBuffer(mime);
      if (duration > 0) source.duration = duration;
      const prune = async (aggressive = false) => {
        const before = video.currentTime - (aggressive ? 5 : 30);
        if (before > 0 && buffer.buffered.length && buffer.buffered.start(0) < before - 1) await update(buffer, () => buffer.remove(0, before));
      };
      const append = async (bytes: Uint8Array<ArrayBuffer>) => {
        await prune();
        // Keep one copy of the pending network chunk. Let playback free quota before retrying it.
        for (;;) {
          try { await update(buffer, () => buffer.appendBuffer(bytes)); return; }
          catch (cause) {
            if (!(cause instanceof DOMException) || cause.name !== 'QuotaExceededError') throw cause;
            await prune(true); await wait(500);
          }
        }
      };
      await append(initial);
      for (;;) {
        signal.throwIfAborted();
        // Backpressure bounds decoded media to roughly 90 seconds ahead, even while paused.
        while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime > 90 * video.playbackRate) await wait(250);
        const chunk = await reader.read(); if (chunk.done) break;
        await append(new Uint8Array(chunk.value));
      }
      signal.throwIfAborted();
      const end = buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0;
      if (duration > 2 && end < duration - 2) throw new Error('The stream stopped before the video finished. Reconnecting…');
      if (source.readyState === 'open') source.endOfStream();
    } catch (cause) {
      if (!signal.aborted) {
        fail(cause instanceof TypeError ? new Error('Waiting for swarm to provide initial video header…') : cause instanceof Error ? cause : new Error(String(cause)));
        controller.abort();
      }
    } finally { if (signal.aborted) void reader?.cancel().catch(() => undefined); }
  };
  source.addEventListener('sourceopen', open, { once: true }); video.src = objectUrl;
  return () => { controller.abort(); void reader?.cancel().catch(() => undefined); source.removeEventListener('sourceopen', open); URL.revokeObjectURL(objectUrl); };
}

export function avcCodecFromInit(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset); if (size < 8) throw new Error('Invalid MP4 box size');
    if (offset + size > bytes.length) return null;
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'moov') {
      for (let i = offset + 8; i + 8 <= offset + size; i++) {
        if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x43 && bytes[i + 4] === 1) {
          return `avc1.${Array.from(bytes.subarray(i + 5, i + 8), value => value.toString(16).padStart(2, '0')).join('')}`;
        }
      }
      throw new Error('Missing H.264 codec configuration');
    }
    offset += size;
  }
  return null;
}
