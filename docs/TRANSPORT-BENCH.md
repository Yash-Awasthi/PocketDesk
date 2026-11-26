# Desktop stream transport: ws vs iroh

Measured 2026-09-25 on one PC (RTX 4060 laptop, NVENC), with `daemon/scripts/transport-bench.mjs`
driven by `transport-bench-matrix.mjs`. Every figure is the mean of two 30-second runs.

## Method

- Source: ffmpeg `testsrc2`, 1920x1080 at 30 fps, the Balanced preset (NVENC, 6 Mbit/s cap),
  so every run sees the same constant-motion stream (about 6.2 Mbit/s).
- Sender and viewer are separate processes on the same machine. Every packet carries its send
  time on the OS performance counter, which both processes share, so latency is exact transport
  latency from encoder output to arrival. Encode and decode time are the same for every transport
  and are not included.
- A frame counts as shown only if its whole chain since the last keyframe arrived. A stall is a
  gap over 200 ms between shown frames; "frozen" is the share of the run spent in stalls.
- Transports:
  - **ws**: today's path. One WebSocket, an infinite GOP, and an ffmpeg restart when the viewer
    falls 1.5 MB behind.
  - **iroh-single**: one QUIC stream with the same restart rule.
  - **iroh-gopN**: one QUIC stream per GOP, a keyframe every N frames, newer GOPs at higher
    priority. A GOP the viewer can no longer use is reset, and ffmpeg is never restarted.
- Network conditions come from clumsy on loopback, which handles each packet twice, so settings
  were halved: "loss3" is about 3% per packet, "lag50" about 50 ms each way (about 100 ms RTT).
  "cap500KBps" is a bandwidth cap below the stream's bitrate.
- Relayed runs drop all loopback UDP so no direct path can form. The local relay is `iroh-relay
  --dev`; the n0 run crosses the internet to n0's public relay and back.

## Results

| transport | condition | fps | p50 ms | p95 ms | stalls | frozen % | sender CPU % |
|---|---|---|---|---|---|---|---|
| ws | clean | 31.1 | 0.3 | 0.5 | 0 | 0 | 1.3 |
| ws | loss1 | 31.0 | 0.5 | 0.9 | 1 | 1.1 | 1.8 |
| ws | loss3 | 31.0 | 0.5 | 1.0 | 1 | 1.1 | 1.4 |
| ws | loss5 | 31.1 | 0.5 | 27.4 | 1 | 1.1 | 1.6 |
| ws | lag50 | 31.1 | 31.9 | 59.9 | 0 | 0 | 2.0 |
| ws | lag50+loss3 | 31.1 | 33.8 | 181.8 | 4 | 3.5 | 1.8 |
| ws | cap500KBps | 14.4 | 4843 | 6756 | 47 | 99.5 | 2.3 |
| iroh-single | clean | 31.1 | 4.2 | 6.8 | 0 | 0 | 9.6 |
| iroh-single | loss5 | 31.1 | 4.8 | 23.4 | 0 | 0 | 8.9 |
| iroh-single | lag50 | 31.3 | 36.9 | 65.7 | 0 | 0 | 8.4 |
| iroh-single | lag50+loss3 | 5.3 | 12528 | 19130 | 59 | 55.9 | 5.0 |
| iroh-single | cap500KBps | 12.1 | 6632 | 9294 | 20 | 96.9 | 5.2 |
| iroh-gop60 | clean | 31.1 | 4.5 | 7.2 | 0 | 0 | 9.7 |
| iroh-gop60 | loss1 | 31.1 | 4.4 | 8.1 | 0 | 0 | 9.8 |
| iroh-gop60 | loss3 | 31.1 | 4.8 | 15.1 | 0 | 0 | 9.8 |
| iroh-gop60 | loss5 | 31.1 | 4.8 | 15.8 | 0 | 0 | 9.0 |
| iroh-gop60 | lag50 | 31.3 | 37.0 | 65.4 | 0 | 0 | 8.9 |
| iroh-gop60 | lag50+loss3 | 5.3 | 983 | 1664 | 52 | 54.2 | 8.6 |
| iroh-gop60 | cap500KBps | 10.3 | 674 | 1503 | 19 | 97.4 | 9.7 |
| iroh-gop30 | clean | 31.1 | 3.8 | 6.7 | 0 | 0 | 8.5 |
| iroh-gop30 | loss5 | 31.1 | 4.7 | 17.3 | 0 | 0 | 9.4 |
| iroh-gop30 | lag50 | 30.8 | 37.5 | 61.2 | 0 | 0 | 9.8 |
| iroh-gop30 | lag50+loss3 | 4.3 | 587 | 898 | 53 | 67.6 | 8.8 |
| iroh-gop30 | cap500KBps | 8.9 | 326 | 743 | 20 | 97.5 | 8.8 |
| iroh-gop60, local relay | relayed | 32.0 | 4.4 | 7.3 | 0 | 0 | 10.8 |
| iroh-gop60, n0 relay (1 run) | relayed over the internet | 32.5 | 67.2 | 300.5 | 0 | 0 | 10.5 |

Connecting took 32–37 ms direct and about 315 ms through the local relay (ws: 2 ms on loopback).

## What the numbers say

1. **Random loss without extra delay:** iroh never stalled at up to 5% loss. ws stalled once per
   run for about 330 ms (a TCP retransmission timeout) even at 1%. This understates the
   difference: Windows loopback TCP sends segments of up to 64 KB, so the same per-packet loss
   touches far fewer ws bytes than QUIC's 1.2 KB datagrams. On a real network ws would lose more.
2. **Loss plus 100 ms RTT:** QUIC throughput fell below the stream's 6 Mbit/s and every iroh
   variant dropped to about 5 fps. ws looked unaffected here only because of the loopback segment
   size. On a real link TCP obeys the same loss-and-RTT limit. So on a bad mobile link, bitrate
   has to adapt whatever the transport.
3. **Bitrate above capacity (cap500KBps):** no transport can carry a stream bigger than the link.
   What differs is how far behind the picture falls: 5–7 s for ws and iroh-single, 0.3–0.7 s for
   iroh-gop. Stream-per-GOP bounds latency to about a GOP, which is its whole point.
4. **Relays:** a local relay added nothing measurable. n0's public relay carried the full 6.7
   Mbit/s with no stalls at 67 ms p50 from this PC, so the relay fallback is usable for video.
5. **Cost:** iroh adds about 4 ms p50 on loopback and uses about 9% of a core to send 6 Mbit/s,
   against about 2% for ws. Most of that is the Node binding copying bytes through JS arrays.
   A Rust sidecar would remove it if CPU ever matters.

## Frame pacing under load

Measured 2026-11-27 on the same PC (i7-13650HX, 14 cores / 20 threads, RTX 4060 Laptop,
2560x1440 at 144 Hz) with `daemon/scripts/frame-pacing.mjs`. The script walks
`ENCODER_ORDER.win32` and applies `ENCODERS` from `daemon/src/desktop_video.js`, so every run uses
the flags the daemon would start with, at the Balanced preset (30 fps, 1:1 pixels, 6 Mbit/s cap).
Source: ddagrab on output 0, the daemon's own Windows graph, 2560x1440 at 30 fps with duplicated
frames. A frame counts only when its FLV tag arrives on ffmpeg's stdout inside the window; a frame
that would arrive later is a drop for a live viewer, because the daemon's CFR output would fill
that slot with a duplicate instead. Each figure is the median of three 6-second windows after a
4-second warmup, and idle and loaded runs alternate inside a repeat, so both meet the same
background load. Load is one spinning Node process per logical CPU, 20 in all.

The box was shared with other sessions compiling in the same tree. Over the first five minutes of
the sweep, total CPU had a median of 100% and 51 of 69 samples at or above 80%, so the "idle"
column is a machine already busy with other work; it only means this script added no load. Drops
inside one condition therefore differ by tens of frames; the per-run column shows that spread and
is the honest resolution of this measurement.

| encoder | codec | load | fps | frames | expected | dropped | dropped per run | max gap ms | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| av1_nvenc | av1 | idle | 30.0 | 180 | 180 | 0 | 0/48/0 | 121 |  |
| av1_nvenc | av1 | full (20 spin) | 27.5 | 165 | 180 | 15 | 15/2/15 | 94 |  |
| av1_qsv | av1 | - | - | - | - | - | - | - | Error creating a MFX session: -9 |
| av1_amf | av1 | - | - | - | - | - | - | - | DLL amfrt64.dll failed to open |
| hevc_nvenc | hevc | idle | 29.3 | 176 | 180 | 4 | 4/25/0 | 156 |  |
| hevc_nvenc | hevc | full (20 spin) | 28.8 | 173 | 180 | 7 | 5/9/7 | 123 |  |
| hevc_qsv | hevc | - | - | - | - | - | - | - | Error creating a MFX session: -9 |
| hevc_amf | hevc | - | - | - | - | - | - | - | DLL amfrt64.dll failed to open |
| h264_nvenc | h264 | idle | 29.7 | 178 | 180 | 2 | 4/2/1 | 69 |  |
| h264_nvenc | h264 | full (20 spin) | 28.2 | 169 | 180 | 11 | 11/8/14 | 106 |  |
| h264_qsv | h264 | - | - | - | - | - | - | - | Error creating a MFX session: -9 |
| h264_amf | h264 | - | - | - | - | - | - | - | DLL amfrt64.dll failed to open |
| libx264 | h264 | idle | 24.8 | 149 | 180 | 31 | 31/33/14 | 76 |  |
| libx264 | h264 | full (20 spin) | 25.7 | 154 | 180 | 26 | 30/26/17 | 135 |  |

What the numbers say:

- Four of the ten encoders the daemon offers on Windows can run here: AV1, HEVC and H.264 on
  NVENC, plus libx264. QSV fails to create an MFX session and AMF cannot load `amfrt64.dll`;
  VA-API and VideoToolbox are not in the Windows order.
- Drops arrive as short stalls, not as a lower average rate: worst gaps are 69-156 ms, which a
  viewer sees as an occasional hitch while the average stays near 30 fps.
- Adding 20 spinners raised NVENC drops from 0/4/2 to 15/7/11 frames per 180. libx264 was already
  short of the rate at 149-154 of 180 with only the other sessions' work on the machine, so the
  extra load changed it little.
- No encoder here is unusable for 1440p30: the worst median is 154 of 180 frames (25.7 fps) on a
  machine that was already saturated, and the software encoder is the one that gets there.

## Decisions

- iroh viewers use stream-per-GOP with a 1-second GOP (gop30 at 30 fps), which bounded latency
  best. The encoder emits a keyframe every `fps` frames; on a static desktop that costs little,
  because ddagrab only sends frames when the screen changes.
- A viewer that drops a GOP to congestion steps the stream down one preset; after 30 s without
  drops it steps back up. That addresses points 2 and 3.
- ws stays for the LAN and the browser client.

## Not measured here

- A real NAT-to-NAT direct path, and a phone on mobile data. These need the Android app on a real
  network; `hello-iroh-ffi` and n0 report about 90% direct connections.
- Decode and display time on the phone.
- Frame pacing at the Quality preset (60 fps): an early run at that preset reached 55-59 fps on
  NVENC and 49 fps on libx264 before any synthetic load, so 60 fps on this desktop measures the
  capture path rather than the encoder.
- Pacing on a machine with nothing else running: no quiet window existed while other sessions
  built in the same tree, so the per-run column carries that noise.
