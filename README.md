# Lumora

A P2P media streaming application: Next.js App Router + TypeScript, Fastify, WebTorrent, FFmpeg, Redis, and optional Supabase Auth/history/bookmarks.

**Hosted demo:** [Open Lumora](https://lumora-web-hari1433.onrender.com) · [API health](https://lumora-api-hari1433.onrender.com/api/health). The public Render Free demo has a 1 GiB selected-video limit, an ephemeral download cache, and cold starts. For large files and reliable local playback, run Lumora on your computer. See [Render deployment details](RENDER.md).

## Run

Requires **Node.js 22.12+** (tested with Node 24 on Windows). FFmpeg and FFprobe binaries install with npm. Native torrent dependencies may need a C++ toolchain on platforms without prebuilt binaries.

```powershell
cd D:\Codex_torrentStreamer\lumora
npm install
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env.local
npm run dev
```

Open **http://localhost:3000** or **http://127.0.0.1:3000** in a browser on this computer. Both local origins are accepted by the API and WebSocket server. For a loopback `FRONTEND_ORIGIN`, the allowlist includes `localhost`, `127.0.0.1`, and `[::1]` with the same scheme and port; unrelated origins remain blocked. The local API runs at `http://127.0.0.1:4000`, and WebSockets at `ws://127.0.0.1:4000/telemetry`. Keep `Start-Lumora.ps1`'s background services running; local playback does not depend on the Codex browser being open.

For normal Windows use, build once with `npm run build`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Lumora.ps1`. This starts a hidden local supervisor independent of an interactive terminal, restarts failed services with backoff, and writes logs under `.runtime`. Use `Stop-Lumora.ps1` before rebuilding. Run the start script again after restarting Windows; the launcher does not install an operating-system startup task.

Active magnets and torrent metadata are saved atomically in `backend/data/.lumora-sessions`. They restore and reverify cached media on restart without Redis or a paid service. **Remove stream also deletes that torrent's downloaded media and saved metadata.** The response waits for file closure and deletion; a failed deletion displays an error and can be retried. Stopping/restarting Lumora and internal peer recovery retain active downloads. Old files left by removals in earlier versions are not swept automatically.

```sh
npm run typecheck
npm test
npm run build
npm start
```

The root is an npm workspace; commit `package-lock.json` with the source. `npm ci` reproduces the locked dependency tree. Run production builds without a development server using the same `.next` directory.

Automated tests use disposable storage under `.runtime` on the project drive and clean it when they finish. They do not use C: for media or compiler caches. The Windows 5/10/13 GiB sparse-offset check is opt-in (`LUMORA_TEST_LARGE_OFFSETS=1`); large-media playback testing is left to the user.

## Optional services

**Redis:** run `docker compose up -d redis`, then set `REDIS_URL=redis://127.0.0.1:6379` in `backend/.env`. Metadata is stored as the binary `.torrent` under `torrent:meta:<hash>` for seven days. Redis failures fall back to an in-memory metadata cache; local session files independently preserve active torrents across restarts. Legacy Redis session keys are still read for migration. A single shared Redis connection uses bounded timeouts and no offline command queue.

**Supabase:** create your own project, execute [`supabase/schema.sql`](supabase/schema.sql) once in its SQL editor, and configure both `.env` files with the project URL and its publishable key. Create an email/password user in that project, then sign in from the dashboard. No service-role key is used. The API validates the user's JWT and forwards it to PostgREST; row-level policies restrict history and bookmarks to their owner. Playback positions save every ten seconds while playing and on pause. The cloud library stores hashes and positions, not the media itself: re-add the source torrent if a saved stream is no longer active.

**FFmpeg:** bundled binaries are the default. Set `FFMPEG_PATH` and `FFPROBE_PATH` to override them with system executables. Review the licenses of the bundled builds before distributing binaries.

## Request flow

1. Submit a magnet or upload binary `.torrent` metadata (50 MiB limit; no base64 duplication).
2. Deduplicate by normalized v1 info hash, consult the memory/Redis metadata cache, and add the cached binary or submitted source to one persistent WebTorrent client. Magnet normalization preserves the literal `urn:btih:` syntax required by the installed parser. Public magnets and uploaded torrents receive fallback trackers through the client; uploaded private torrents preserve their tracker privacy settings. Uploading metadata for an unresolved magnet can restart discovery from the supplied metadata.
3. Select the largest MP4/MKV/AVI/WebM file. Initially select only its first 2 MiB: WebTorrent's new-peer validation walks the end of its lowest selection, so a broad startup selection can divert requests away from headers. Once verified, enable bounded MP4 first/last 2 MiB or MKV first 10 MiB prefetch, bitrate-aware per-reader/per-player windows (8–64 MiB urgent, 32–192 MiB ahead, 5 MiB behind), and low-priority sequential caching of the remaining selected video. Background caching continues when no player is open. This consumes disk space for the selected video and prevents the previous idle-window download cutoff.
4. Mark the selected video's first piece critical immediately. Before spawning FFprobe or FFmpeg, wait for every piece overlapping its first 2 MiB (or the whole file if smaller) to be verified. This uses file-relative offsets, including multi-file torrents. A 30-second wait returns HTTP 503 `INITIAL_BUFFER_PENDING` / “Buffering initial chunks” with `Retry-After: 3`; disconnects cancel the wait. Then probe through a token-protected, loopback-only HTTP range source. FFprobe and FFmpeg can seek to container indexes at EOF before the torrent finishes. Probe results are deduplicated and cached in process memory.
5. H.264/AAC MP4 bypasses FFmpeg and serves exact HTTP ranges. Other supported media gets video stream copy into fragmented MP4. AAC is copied; other audio is converted to 192 kb/s AAC with timestamp recovery and asynchronous resampling. No video encoder is used by playback.
6. Publish torrent speed, peers, progress, contiguous verified bytes, and initial-header readiness every 500 ms over WebSockets. Play stays disabled with “Buffering initial pieces...” until those header pieces are verified; a direct watch URL also waits before requesting media. Network/source errors keep the player visible with an inline waiting message and Retry. Browser-decoded buffer seconds are displayed separately from torrent download progress.

## Seeking and cleanup

Direct streams implement full responses, single closed/open/suffix ranges, HEAD, and 416 errors with `Content-Range: bytes */size`. Multipart byte ranges are rejected. Reads use backpressure and bounded 4 MiB WebTorrent source streams, preventing an open-ended request from selecting every piece to EOF. Destroying the HTTP response cancels the source iterator and its priority lease.

Remux output is a new representation: its byte offsets differ from the source. It returns HTTP 200 with `Accept-Ranges: none`, and does **not** advertise source byte ranges. H.264 remuxes use Media Source Extensions with bounded buffering; already-buffered seeks reuse that buffer. An outside-buffer seek restarts FFmpeg using an input `-ss` seek, with a fresh fragmented MP4 stream. Seeks align to source keyframes; with video copy, arbitrary frame-exact cuts cannot be guaranteed. Source timestamps and regenerated audio timestamps remain in the same remux process. Disconnects kill FFmpeg immediately. Probe work has a 45-second deadline and may be shared by multiple viewers; an abandoned inspection can continue until it completes or times out. Removing a torrent kills its media processes. Process count defaults to four; active torrents default to eight.

Before a remux seek, the player requests `/api/media/:infoHash/seek?time=seconds`. FFprobe reads one indexed video packet, and the returned source keyframe becomes the player’s new time origin. This avoids labeling video preroll with an incorrect requested timestamp. Keyframe lookup has a 30-second timeout. Sources without usable seek indexes can fail this lookup; the UI reports the failure rather than pretending that arbitrary seeking succeeded.

The seek path accounts for the container's `start_time` and uses FFmpeg `-seek_timestamp 1`, so FFprobe's absolute keyframe timestamps and the player's elapsed-time timeline agree, including containers with negative audio preroll timestamps.

The player reports a time-to-byte estimate to accelerate seeks. It is a **hint**, not an exact map for variable-bitrate video. Actual HTTP range requests from the browser or FFmpeg control authoritative byte priorities. Stalls retry at most three times after 12 seconds each; user-triggered Retry resets that budget.

HTML5 network/source errors use that same retry budget with 1.5/3/4.5-second delays and explicitly reload the source, including direct MP4. A paused error element cannot recover through the ordinary playing-only stall timer. Persistent failures keep controls visible and explain that the stream or codec remains unavailable. Connection details show active senders, choking, header availability, verified bytes, and announcement results. Refresh peers is rate limited to once per 30 seconds and refreshes tracker/DHT discovery; it can restart a failed session from saved metadata. If WebSockets fail, HTTP snapshots keep the dashboard usable. An unreachable API gets a clear engine-offline message.

## Performance targets and boundaries

- **Sub-5-second TTFF and zero buffering are targets, not guarantees.** A dead swarm, ISP filtering, remote peer upload limits, sparse keyframes, or insufficient sustained throughput cannot be fixed by client code. A 100 Mbps connection carries at most 12.5 MB/s before protocol overhead; media bitrate must remain below the actual sustained download rate.
- Cached metadata avoids swarm **metadata** discovery, not peer discovery or the transfer of media bytes. Redis/FFprobe/cache verification still take time. Cold peers cannot be guaranteed within five seconds.
- **Original quality** copies video packet payloads without re-encoding. Player settings also offer lower resolutions (1080p, 720p, 480p, 360p, only below the source height); these use live H.264/AAC conversion on this computer. Switching quality retains the playback position and pause state. Lower resolutions reduce the stream sent to the player, but do not reduce the original torrent's download size. Conversion uses CPU and may be slower than Original on limited hardware.
- Converting AC3/DTS/TrueHD to AAC changes audio and is lossy; therefore the **entire audiovisual bitstream** is not untouched on that path. Containers and timestamps also change during remuxing.
- H.264 is the baseline browser codec. HEVC, AV1, and VP9 are passed through and depend on the browser/platform decoder. Unsupported video codecs (such as MPEG-4 Part 2 in many AVI files) return a clear 415 error instead of silently transcoding video. Embedded subtitles and secondary audio tracks are not selected. The player can load local SRT or WebVTT subtitles.
- The on-screen “Play → frame” measure starts at the player's play action and uses the next rendered video-frame callback when available (playing event fallback). It excludes ingestion, metadata discovery, and inspection; it is not an end-to-end TTFF benchmark.
- WebTorrent defaults to 100 connections per torrent, configurable with `MAX_PEER_CONNECTIONS`. A separate admission guard limits established swarm wires to 250 across torrents; it is **not** a cap on all transient connecting TCP sockets. Upload throughput defaults to 3,000,000 bytes/s, configurable with `UPLOAD_LIMIT_BYTES` (`-1` for unlimited).
- Peer data uses native TCP directly (`utp: false`) to avoid waiting for uTP fallback on filtered networks. DHT and UDP tracker discovery still use UDP; LSD and PEX remain enabled.
- WebTorrent stores downloaded pieces in `backend/data`, isolated by info hash. Removing a stream closes its readers and deletes its downloaded data. Stopping/restarting Lumora retains active sessions and their files. Older orphaned downloads are not automatically swept.
- The priority adapter is intentionally pinned to WebTorrent **3.0.21**. Its public `select()` merges overlapping priorities, so the isolated adapter maintains identity-owned entries in its internal selection table. Those entries are separate from file-iterator selections; equal-bounds reader cleanup cannot remove a header or playback window. Regression tests use the installed selection implementation. Re-run the suite before upgrading.

## Local service boundary

The default API binds to loopback, checks Host/Origin, restricts CORS, and authenticates cloud-library operations. Torrent ingestion and streaming are designed for one trusted local workspace; **do not expose port 4000 publicly**. A hosted multi-user deployment needs a trusted authentication gateway covering HTTP and WebSocket upgrades, per-user torrent authorization, quotas, egress controls, and TLS. This native TCP/UDP/child-process backend cannot run in an ordinary serverless/edge function.

Magnet exact-source/web-seed URLs are removed to avoid implicit HTTP source fetching; trackers and uploaded torrent metadata still cause network connections by design. Use trusted torrent sources and media you are permitted to download and share. Downloading with WebTorrent also uploads verified pieces to peers.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/magnet` | `{ "magnet": "magnet:?xt=…" }`, returns 202 snapshot |
| POST | `/api/upload` | Multipart `file` containing `.torrent` bytes |
| GET | `/api/active` | Active snapshots |
| GET / DELETE | `/api/torrents/:infoHash` | Snapshot / remove and delete downloaded data |
| GET | `/api/media/:infoHash` | Codec inspection and duration |
| GET | `/api/media/:infoHash/seek?time=seconds` | Resolve a remux seek to a source keyframe |
| GET / HEAD | `/api/stream/:infoHash?start=seconds` | Direct range or remux stream |
| POST | `/api/torrents/:infoHash/playhead` | `{ sessionId: UUID, byteOffset, bufferedSeconds }` |
| POST | `/api/torrents/:infoHash/refresh` | Refresh discovery or restart a failed session; 30-second cooldown |
| GET | `/api/health` | API and Redis connection state |
| GET | `/api/library` | User watch history (Bearer JWT required) |
| PUT | `/api/library/:infoHash` | Save name, position, duration, bookmarked (Bearer JWT) |
| WS | `/telemetry` | `{ type: "snapshot", torrents: [...] }`; reconnect with exponential backoff |

## Verification

`npm test` generates an eight-second H.264/AC3 test clip, seeds it over a real **local** torrent connection, and exercises metadata ingestion/deduplication, exact 206 and suffix bytes, 416, HEAD, WebSocket snapshots, AC3→AAC remuxing, source/output video-packet SHA-256 equality, seek timestamps, aborted remux cleanup, and torrent removal. Unit checks include 13 GiB range arithmetic, offset piece mapping, tracker injection, and unsupported-codec handling. Tests never require a public media torrent.

The cold-playback integration generates a 43 MiB MKV, submits a magnet through HTTP, exchanges metadata with a throttled local seeder, and asserts that remux bytes arrive before the whole file is downloaded. It also submits multipart torrent metadata to the real upload route. Persistence and diagnostic-state regressions cover restart storage and distinguish missing peers, missing header pieces, and choking.

For browser QA, run `node --import tsx test/browser-fixture.ts` from `backend`. It generates private synthetic MP4/MKV torrents backed by a loopback tracker and writes them to `test-results/fixtures`. Upload those files through the dashboard while the helper runs. Stop the helper with Ctrl+C when finished.

Large public swarms, sustained 5/10/13+ GB playback, long-distance seeking, Redis reconnection/persistence, and live Supabase RLS require their own configured integration environment. Passing local checks does not validate those network-dependent guarantees.

The stalled-MKV regression holds the source at 0% for the full 30-second header deadline. Both media inspection and streaming return a retryable 503 without launching FFmpeg/FFprobe, release readiness listeners, and leave the API responsive. Additional checks cover missing middle pieces, nonzero file offsets, short files, disconnect cancellation, and torrent removal. Verified initial bytes prevent premature probing; they do not guarantee that later clusters or keyframes have arrived.

References: [WebTorrent API](https://webtorrent.io/docs), [FFmpeg formats](https://ffmpeg.org/ffmpeg-formats.html), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Next.js App Router](https://nextjs.org/docs/app).

## Player and latest measurements

The cinema player saves resume positions, bookmarks, volume and speed locally without an account. Optional Supabase enables cloud sync. See [PERFORMANCE.md](PERFORMANCE.md) for the measured before/after benchmark, real network throughput, and playback boundaries.
