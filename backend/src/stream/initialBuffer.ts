import type { PieceSelector } from '../torrent/pieceSelector.js';

export const INITIAL_BUFFER_TIMEOUT_MS = 30000;
export function bufferingError() {
  return Object.assign(new Error('Buffering initial chunks'), { statusCode: 503, code: 'INITIAL_BUFFER_PENDING' });
}

// Listen for verified pieces instead of polling overall download progress.
// Every exit removes listeners and timers, including an abandoned HTTP request.
export async function waitForInitialBuffer(selector: PieceSelector, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  if (options.signal?.aborted) throw options.signal.reason;
  if (selector.isClosed) throw bufferingError();
  if (selector.initialBufferReady) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      selector.removeListener('initialBufferReady', onReady);
      selector.removeListener('closed', onClosed);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onReady = () => { if (selector.initialBufferReady) { cleanup(); resolve(); } };
    const onClosed = () => { cleanup(); reject(bufferingError()); };
    const onAbort = () => { cleanup(); reject(options.signal?.reason); };
    const timer = setTimeout(onClosed, options.timeoutMs ?? INITIAL_BUFFER_TIMEOUT_MS);
    selector.on('initialBufferReady', onReady);
    selector.once('closed', onClosed);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Cover readiness/abort changes between the first check and subscription.
    if (options.signal?.aborted) onAbort();
    else if (selector.isClosed) onClosed();
    else onReady();
  });
}
