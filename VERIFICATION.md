# Verification — 30 September 2026

## Local browser access and disk cleanup

The origin allowlist previously accepted only `http://127.0.0.1:3000`; `http://localhost:3000` was rejected by both API and WebSocket paths. The shared browser-access policy now allows the configured loopback aliases on the same scheme/port, while rejecting unrelated domains and ports. HTTP requests, DELETE preflights, and real WebSocket snapshot connections pass for each alias. Both services were stopped when this report was investigated and were rebuilt/restarted.

Remove now closes torrent readers, deletes the validated per-torrent storage directory, and removes saved session/metadata before returning success. The installed WebTorrent promise does not await storage closure, so the implementation waits for its callback instead. Internal recovery explicitly retains data. Concurrent removals are deduplicated; re-add waits for deletion. Failed deletion remains retryable. Files outside the selected torrent directory and downloads from older removals are not swept.

All **20 tests** pass, including actual local-swarm HTTP deletion, deleting a previously destroyed torrent, removal of saved sessions/metadata, retention during internal recovery, neighboring-file preservation, path rejection, and prior playback/synchronization regressions. Fixtures use disposable D: storage with automatic cleanup; no large-file/public-network benchmark was run.

The rebuilt app was opened at `http://localhost:3000` and showed Engine connected / Online without browser console warnings or errors. Live API calls returned HTTP 200 with the matching CORS origin for both `localhost:3000` and `127.0.0.1:3000`. Production frontend/backend builds passed. Individual Brave, Comet, and Firefox windows were not available through the connected browser tool, so those browser-specific playback sessions were not directly observed.

## Audio synchronization and quality selection

All 18 automated tests passed after the timing and quality changes, including the existing torrent, zero-buffer guard, fidelity, and cancellation tests. Backend TypeScript and the production frontend build passed. Small generated timing fixtures were stored on D: and automatically removed; no large-file test or public-torrent download was performed.

The previous muxer wrote `empty_moov` without `delay_moov`, losing initial audio track timing in the reproduced case (the first AAC packet shifted to 0 instead of 0.562 seconds). Input accurate seeking also trimmed converted audio while retaining copied video preroll. A B-frame MKV sought to 4 seconds previously emitted video from the preceding 2-second keyframe. The new path preserves preroll for both tracks, compensates the Matroska B-frame seek heuristic, removes audio-only `first_pts=0`, and delays initialization until track timestamps are known. See [FFmpeg's muxer documentation](https://ffmpeg.org/ffmpeg-formats.html) and [seek implementation](https://ffmpeg.org/doxygen/7.1/ffmpeg__demux_8c_source.html).

The regression uses repeated audible markers, delayed track starts, and B-frames. At startup and after a 4-second seek, AAC-copy and AC3-to-AAC output preserve marker timing relative to the original video within 25 ms; copied audio packet timing agrees within 2 ms. Every Original video packet remains byte-identical. Lower-resolution output is H.264 at 360p and preserves marker timing within 30 ms. The quality ladder rejects upscaling.

Browser verification on a 2.1 MB local synthetic torrent confirmed an actual 480p-to-360p change at 12.6 seconds while paused, successful playback of the remainder, and restoration of Original 480p at the retained position. No browser warning/error logs were recorded. The affected user torrent had already been removed from the running app, so its specific soundtrack was not rechecked.

## Earlier optimization verification — 27 September 2026

Cleanup note: at the user's request, generated test media, screenshots, and raw files under `test-results` were removed after verification. The measurements below record the completed checks. Further large-media testing is reserved for the user. No full 13 GB media fixture was generated.

## Latest production build

The updated backend and cinema player pass `npm run build`, `npm run typecheck`, and all **16 automated tests**. The suite now also checks bitrate-aware prefetch, disjoint buffered seek ranges, subtitle parsing, partial MP4 initialization, repeated seek caching, cancellation of seek workers, and retaining new magnet trackers when metadata is cached.

After the Windows sparse-store adapter was integrated, the backend was rebuilt and all 16 standard tests passed again. This includes actual torrent reads and remuxing through the updated store. The separately exercised sparse-offset check passed before the user stopped large-file testing. Standard tests now isolate all media and compiler temporaries on the project drive and remove them on completion.

Browser checks on the latest player:

- Dashboard `.torrent` upload and public Sintel magnet ingestion reach playable state. The real-network sample peaked at **10.37 MB/s**; raw samples were subsequently removed during cleanup.
- H.264/AC3 MKV plays through its full **24.025-second** output with **580 decoded frames**, no media error, and a full seekable range. MSE fixes the native remux path that previously stopped after approximately 5.5 seconds despite a complete backend response.
- A buffered ten-second backward seek makes no additional FFmpeg or FFprobe process. A three-minute fixture buffers approximately **90.021 seconds** while paused and successfully loads a new source when the timeline seeks to **150.5 seconds**, outside that buffer.
- Keyboard play/pause, speed selection, persistence of 1.5× speed across reloads, fullscreen, local bookmark saving, and resume at the saved position pass. Local WebVTT loading creates a visible text track.
- After the outside-buffer seek, the remaining **30.010 seconds** played to completion with **724 decoded frames**, no media error, and the UI at **3:00 / 3:00**. The local subtitle cue shifted to start at 0 and end at 29.979 seconds in the new source, preserving its original timeline.
- Blocking all media requests leaves an inline recovery UI. Removing the block and pressing Try again resumes decoded playback without a media error.
- Desktop and 390-pixel mobile layouts were visually checked; mobile document width is exactly 390 pixels. The verification screenshots were subsequently removed during cleanup.

After cleanup, the running production dashboard returned HTTP 200 and the backend reported `status: ok`, version 1.2.0, local-disk persistence, and zero active media processes. The frontend production build is newer than its source files; the backend includes the compiled sparse-store adapter. No generated `test-results` directory or disposable test directories remain. This final check did not download media or repeat large-file testing.

See [PERFORMANCE.md](PERFORMANCE.md) for the controlled first-fragment comparison and limitations. Picture-in-picture availability is detected but its separate operating-system window was not verified. The older checks below are historical evidence from the preceding implementation, not new measurements of this player.

## Earlier verification — 21 September 2026

Environment: Windows, Node 24.16.0, Next.js 16.3.5, WebTorrent 3.0.21, bundled FFmpeg/FFprobe. Automated media fixtures were generated locally. Separate network diagnostics used the Creative Commons Big Buck Bunny and Sintel torrents from WebTorrent's official free-torrent list.

| Check | Result |
|---|---|
| Production frontend and backend builds | Pass |
| Standalone strict TypeScript checks | Pass |
| Automated tests | 12 passed, 0 failed |
| Actual magnet parsing | Raw, encoded, tracker-rich, and base32 magnets pass the installed parser after normalization |
| Cold MKV over HTTP | 43.4 MiB source; HTTP magnet ingestion, metadata exchange, remux bytes at 5.6% downloaded (720 ms after the stream request in the final run), multipart upload deduplication |
| Public network | Big Buck Bunny reached 9.36 MB/s with native TCP peers plus an HTTP seed; fresh Sintel magnet reached 8.94 MB/s, initial readiness by the 5-second sample, completion by the 25-second sample |
| Browser ingestion/playback | Actual dashboard MKV upload and MP4 magnet submission both reached playing state with decoded frames and no page errors |
| Process recovery | Deliberately stopped backend; supervisor restarted it and restored both synthetic sessions at 100% verified, with Redis disabled |
| Media recovery | Browser request interception caused a real HTML5 code 4 error; after unblocking, automatic source reload cleared the media error, decoded frames, and reached readyState 4. Browser autoplay policy can still require pressing Play |
| Diagnostics layout | Updated dashboard checked at 390 px; document width equals viewport width |
| MKV at 0% | Full 30-second initial-header deadline returns HTTP 503 with retry metadata; no FFmpeg/FFprobe processes spawn; API remains responsive |
| Header readiness | Every overlapping initial piece must be verified; offset files, missing middle pieces, short files, cancellation, and removal pass |
| Buffering browser UI | Isolated production frontend: Play disabled at 0%; direct watch URL mounts no video and makes no inspection/stream requests before readiness |
| Video error UI | Real failed source produced HTML5 code 4; injected code 2 event also retains the player and displays the inline waiting message |
| HTTP ranges | Closed/open/suffix, single-byte, HEAD, 416, and 13 GiB arithmetic pass |
| Torrent ingestion | Real loopback swarm; binary metadata deduplication and selected video reads pass |
| Priority lifecycle | Installed WebTorrent selection implementation tested for equal-bounds header/read cleanup |
| Telemetry | WebSocket snapshot contains the active torrent and live state |
| Video fidelity | Source and remuxed encoded video packet SHA-256 sequences match exactly |
| Audio conversion | AC3 source produces AAC output |
| Seeking | Non-keyframe request resolves to a source keyframe; container start-time offset is respected; output duration and A/V start timestamps checked |
| Cleanup | Cancelled remux leaves zero tracked FFmpeg processes; readers and torrent removal clean up |
| Browser flow | File upload, direct MP4 playback/seek, MKV remux playback, and keyframe timeline exercised |
| Responsive layout | Desktop and 390 px mobile checked; mobile document width equals viewport width; no Next.js error overlay |

Not verified: the user's specific stalled torrent (no source supplied), sustained 5/10/13+ GB swarm playback, global network TTFF under five seconds, a 30-minute real-world A/V seek, live Redis reconnection/session restoration, and live Supabase Auth/RLS. Redis and Supabase were not configured on this machine. The twelve tests include multiple assertions; their count is not a count of supported features. Remux first-byte measurements are not browser first-frame measurements and do not imply a guaranteed startup time on other swarms.

Run `npm test`, `npm run typecheck`, and `npm run build` from the workspace root to repeat the automated checks. The manual browser fixture helper and deployment boundaries are documented in `README.md`.
