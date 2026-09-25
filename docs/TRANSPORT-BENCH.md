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
