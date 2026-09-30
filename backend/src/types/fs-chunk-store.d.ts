declare module 'fs-chunk-store' {
  type Callback<T = void> = (error: Error | null, value?: T) => void;
  export default class FileStore {
    constructor(chunkLength: number, options: Record<string, unknown>);
    files: Array<{ path: string; open(callback: (error: Error | null, file?: unknown) => void): void }>;
    put(index: number, data: Uint8Array, callback: Callback): void;
    get(index: number, callback: Callback<Uint8Array>): void;
    get(index: number, options: { offset?: number; length?: number }, callback: Callback<Uint8Array>): void;
    close(callback: Callback): void;
    destroy(callback: Callback): void;
  }
}
