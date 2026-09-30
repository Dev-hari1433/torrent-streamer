# Streaming investigation — 21 September 2026

## Confirmed failures

1. **Magnet normalization broke the real parser.** Adding trackers using `URLSearchParams` encoded `urn:btih:` as `urn%3Abtih%3A`. The installed `magnet-uri` parser does not decode `xt`, so `parse-torrent` rejected valid magnets with HTTP 400. The old test checked URL parameters rather than actually parsing/submitting the result. Normalization now preserves the required syntax; HTTP cold-playback and parser regressions reproduce and cover this failure.
2. **The backend was offline at the start of this investigation.** Port 4000 refused connections and there was no Lumora Node process. No retained exit log identified why the earlier process had stopped. A separate hidden supervisor now records stdout/stderr and exit status and restarts crashed services. Windows start/stop scripts make operation independent of the development task.
3. **Session storage depended on optional Redis.** Without it, process restarts discarded all active torrents. Atomic local session records now preserve magnets before metadata discovery and replace them with binary metadata when available. A forced process restart restored both tested sessions and reverified cached files.
4. **Startup selections competed with the header.** Installed WebTorrent validates new peers by walking the end of low-priority selections and rotates nonzero selections; numeric priorities do not guarantee strict header-first order. A broad 75 MiB initial window and percentage-based MP4 tail prefetch could divert scarce bandwidth. Initial selections now contain only the first 2 MiB; after verification, bounded headers, reader windows, and background caching start.
5. **Idle downloads stopped at the prefetch window.** The public diagnostic reproducibly stopped at 30.6% despite many unchoked peers because the engine had no remaining selected pieces. Background selection was conditional on a player reporting 30 seconds buffered. The selected video now keeps downloading at low priority even before playback.
6. **Metadata uploads lacked consistent discovery fallbacks.** Fallbacks existed only in magnet normalization. Client-level fallback trackers now apply to public torrents, including uploaded metadata, while WebTorrent preserves uploaded private-torrent restrictions.
7. **A paused media-error element bypassed stall recovery.** The old timer required an unpaused element. Network/source errors now schedule bounded explicit source reloads, and direct MP4 Retry reloads failed media instead of only setting its playback time.

## What the network evidence does and does not establish

The same machine downloaded official Creative Commons test torrents at roughly 9 MB/s with native TCP peers and working DHT discovery. This disproves a blanket P2P network block for the tested connection. It does not establish that every peer, tracker, or torrent is reachable, nor that the user's original source has usable seeders. Individual tracker failures occurred while the downloads succeeded.

Connection details now expose peer transfer, choking, required-piece availability, verified bytes, and recent warnings instead of showing an unexplained spinner. A two-peer swarm can still fail to deliver data even on a fast internet connection. A different server cannot create pieces that no available peer has.

## Free hosting

No cloud service is required for this local implementation. Render's free service sleeps after inactivity, takes time to wake, and has no persistent disk; that is unsuitable for promising instant, durable multi-gigabyte torrent playback. Keep the native streaming engine on this computer for now. A public multi-user deployment is a separate project requiring authentication, isolation, quotas, and an appropriate persistent TCP/UDP host.

References: [WebTorrent free torrents](https://github.com/webtorrent/webtorrent/blob/master/docs/free-torrents.md), [Render free-service limits](https://render.com/docs/free). Detailed measured checks and limitations are in `VERIFICATION.md`.
