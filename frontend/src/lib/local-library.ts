export interface LibraryEntry { info_hash: string; name: string; position: number; duration: number; bookmarked: boolean; updated_at?: string }
const KEY = 'lumora.library.v1';
export function readLocalLibrary(): LibraryEntry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(data) ? data.filter((item): item is LibraryEntry => item && /^[a-f0-9]{40}$/.test(item.info_hash)
      && typeof item.name === 'string' && Number.isFinite(item.position) && Number.isFinite(item.duration)).slice(0, 100) : [];
  } catch { return []; }
}
export function saveLocalWatch(entry: LibraryEntry) {
  try {
    localStorage.setItem(KEY, JSON.stringify([{ ...entry, updated_at: new Date().toISOString() }, ...readLocalLibrary().filter(item => item.info_hash !== entry.info_hash)].slice(0, 100)));
    window.dispatchEvent(new Event('lumora-library'));
  } catch { /* Private browsing or a full local store must not stop playback. */ }
}
