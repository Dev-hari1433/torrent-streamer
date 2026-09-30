# Playback optimization — 27 September 2026

## Follow-up investigation — 30 September 2026

The previous local benchmarks did not establish startup performance for every public swarm. Two recent uploads were accepted in 60–97 ms but removed before any media probe or remux started. Their logs contained tracker failures and `No nodes to query`.

A metadata-only network comparison on this PC reproduced a DHT bootstrap failure: the configured hostname-based routers produced zero nodes after 15 seconds. The installed DHT library resolves hostnames without a family constraint and sends on an IPv4 UDP socket, while the system returned IPv6 first for `dht.transmissionbt.com`. Explicitly resolving its IPv4 addresses discovered 25 nodes within eight seconds. The other two standard routers returned no nodes during that sample. Startup now resolves all IPv4 addresses with a bounded DNS deadline. Idle torrents retry discovery with backoff instead of relying on the library's roughly 15-minute announce interval or a manual refresh.

When the user re-added the affected 284 MB torrent, it reached 6,846,100 bytes/s with three peers and a verified initial buffer. A browser check played it continuously for 87 seconds without a media error. The first on-demand inspection took 4,382 ms. Inspection now begins automatically when the initial pieces are verified, sharing the same cached job with playback requests and reserving capacity for foreground work. This overlaps preparation with time spent on the dashboard; it does not eliminate the need to acquire initial pieces.

Structured logs separate `torrent.playable`, `media.inspected`, and `media.firstBytes` timings. The last is server output latency, not first rendered frame. Connection details report reachable DHT nodes instead of incorrectly describing every completed DHT attempt as successful. No additional public media torrent or large-file benchmark was downloaded for this investigation.

Verification after rebuilding/restarting: the running service reached 21 DHT nodes within ten seconds. It restored the existing downloaded file and completed one background inspection before any stream request. The watch-page media request then took 5.2 ms, with first remux output in 3,416 ms. The browser subsequently advanced to 27 seconds with no media or console errors and 128 seconds buffered. This final playback check used cached source data, not a fresh download. All 22 regression tests and both production builds passed; generated suite media was removed automatically.

The main latency fixes are earlier MP4 fragments, bounded media probing, bitrate-aware piece prefetch, and browser-managed buffering for H.264 remuxes. A new cinema player replaces the Plyr interface.

Generated test media and raw artifacts were removed at the user's request after these measurements. The figures below are the recorded results; further large-media checks are left to the user.

## Measured cold-swarm comparison

`backend/test/benchmark.ts` generates a 60-second H.264 MKV with 10-second keyframe spacing and approximately 6 Mbps video. A local TCP seeder is limited to 1 MiB/s. Each run uses a new torrent hash and empty cache. Timings exclude fixture generation. This is a single before/after pair, not a percentile study.

| Measurement | Before | After |
|---|---:|---:|
| Ingestion | 16 ms | 15 ms |
| Initial verified header | 1,227 ms | 1,204 ms |
| Stream request to first media fragment (`moof`) | 6,706 ms | 2,260 ms |
| Add torrent to first media fragment | 7,963 ms | 3,479 ms |
| Video downloaded at that point | 20.3% | 7.7% |

The first media fragment arrived 66% sooner, and add-to-fragment time fell 56%. The old path emitted an MP4 initialization header quickly but waited for a keyframe before useful media. One-second fragment boundaries remove that wait without re-encoding video. These measurements identify the first fragment header, not its complete download or the browser's first rendered frame. Do not describe them as guaranteed TTFF.

The original raw results were saved as `benchmark-baseline.json` and `benchmark-optimized.json` and subsequently removed during cleanup. The benchmark source remains available for a user-requested future run.

## Real network check

The Sintel magnet from [WebTorrent's free torrent list](https://webtorrent.io/free-torrents) was submitted through the dashboard on this machine. It reached 10,370,292 bytes/s, approximately 83 Mbps, with 21 peers at that sample. Initial pieces were verified at the second two-second sample, and the selected video was complete at the eighth. Sampling began shortly after submission; those sample offsets are not exact ingestion timestamps. The browser decoded and played the public sample without a media error. The raw samples were removed during the requested cleanup.

This establishes that native torrent transfers work on this connection. It does not establish that every tracker is reachable or that another swarm contains a peer willing to supply its missing pieces.

## Delivery and player changes

- FFprobe uses a short initial analysis, with a longer fallback when dimensions or duration are missing. Inspection is cached, and repeated keyframe lookups reuse a bounded cache. Superseded seeks kill their probe processes.
- Prefetch uses estimated media bitrate and browser buffer depth: 12–30 seconds of urgent data and about 90 seconds ahead, with byte limits. Authoritative HTTP reads still control exact source-byte priorities.
- H.264 remux playback uses Media Source Extensions. The client derives the AVC codec profile from the initialization segment, appends fragments serially, limits buffering to roughly 90 seconds ahead, and removes old data. This avoids native range probes against a live response. HTTP backpressure reaches FFmpeg and the torrent reader. Direct H.264/AAC MP4 keeps byte-range playback.
- Buffered seeks reuse the browser buffer without a new remux. Outside-buffer seeks resolve a source keyframe, cancel the old stream, and start at that keyframe. Browser QA confirmed a ten-second backward seek with zero additional remux/probe processes.
- The custom player includes a buffered timeline, skip controls, fullscreen, picture-in-picture when supported, speed and volume settings, fit/fill, local SRT/WebVTT subtitles, keyboard shortcuts, visible recovery states, and local resume/bookmarks. Cloud sync remains optional.
- Peer connections default to 100 per torrent. Upload capacity defaults to 3,000,000 bytes/s across the client and is configurable with `UPLOAD_LIMIT_BYTES`; `-1` disables that cap. Keep upload headroom on asymmetric connections. No download-rate cap is configured.
- Windows torrent files are marked sparse before out-of-order writes, avoiding allocation of unwritten gaps when downloading distant pieces. The adapter targets pinned `fs-chunk-store` 5.0.1. Standard regression tests run in disposable project-drive storage; the 5/10/13 GiB sparse-offset check is opt-in.

## Boundaries

Healthy peer throughput must exceed the video's bitrate. Local code cannot make absent seeders deliver data or remove ISP filtering. Browser codec support still applies; non-H.264 remuxes use native playback and are not covered by the new MSE browser checks. Audio other than AAC is converted to AAC; only the video bitstream is guaranteed to be copied. Large-file arithmetic is tested, but sustained 5/10/13 GB playback has not been benchmarked. No paid cloud service is required for the local application.

MSE implementation follows the browser [SourceBuffer append lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/appendBuffer) and [MediaSource duration API](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/duration).
