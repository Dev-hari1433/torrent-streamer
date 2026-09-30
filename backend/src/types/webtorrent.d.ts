import 'webtorrent';
declare module 'webtorrent' {
  interface Torrent {
    readonly destroyed: boolean;
    readonly bitfield: { get(index: number): boolean };
  }
}
