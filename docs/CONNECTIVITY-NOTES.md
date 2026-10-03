# Connectivity and security notes

How the phone reaches the PC, why that is safe, and the one gap left. Written from reading the
code at `daemon/src/config.js`, `daemon/src/server.js`, `app/.../WsClient.kt`, `ConnectRoute.kt`
and `Pairing.kt`. Nothing here was changed in the app.

## How the phone finds the PC

The pairing QR carries a LAN URL, the token, the TLS fingerprint and an iroh ticket. The app
tries the LAN address first and falls back to iroh when it does not answer. On mobile data the
LAN attempt is skipped (`ConnectRoute.pick`).

iroh addresses the PC by public key instead of IP:

1. The daemon keeps an outbound connection to a relay. The ticket holds its public key, relay
   URL and current addresses.
2. The phone dials that key. The QUIC handshake first runs through the relay, so the session is
   usable immediately and the phone checks the PC's signature against the key in the ticket.
3. In parallel both sides learn their public IP:port, swap candidates over the relay, and send
   probe packets at each other at the same moment.
4. Each probe makes the sender's own router create a temporary NAT entry that admits replies from
   that exact address. The first probe is dropped by the far router; the entry on the sending
   side is the point. Once both entries exist, traffic flows directly and QUIC moves to that path
   with the same session key.
5. If the NAT is symmetric or behind carrier NAT, the port seen by the relay differs from the one
   used toward the peer, probes miss, and traffic stays on the relay.

Hole punching is not port forwarding. No router setting changes, no port stays open to the
internet, and the entry fits one remote address and expires when idle.

## Security properties

- Token: 24 random bytes (192 bits), compared with `timingSafeEqual`. It is the root credential.
- iroh: the connection is end to end encrypted and bound to the PC's key. Relays see ciphertext
  only. The ticket is an address, not a credential; the token and the device's paired key still
  gate every command.
- Hole punching only opens a network path. Authentication is separate: a stranger who reaches the
  port fails the QUIC handshake.
- LAN: the daemon generates a self-signed certificate on first run and turns TLS on. The QR
  carries `wss://` and the fingerprint, and the app pins it (`Tls.pinnedClient`). A rogue device
  on the same IP cannot match the pin, so the token is never sent to it.

## Remaining gap

`WsClient.kt` sends the `hello` with the token as soon as a plain `ws://` socket opens, with no
check that the server is the PC. This only applies to entries that are `ws://`: pairings made
before TLS, hand-typed URLs, or a daemon where certificate generation failed. On untrusted
Wi-Fi, a device holding the saved LAN IP could read the token.

Mitigation today: make sure the saved entry starts with `wss://`. If not, re-scan the pairing
QR once. Possible hardening, not done: refuse `ws://` unless the host is loopback, the Android
emulator address, or a Tailscale address (`100.64.0.0/10`), and ask the user to re-pair.

## Behaviour on network change

`WsClient.onNetworkChanged`: an iroh connection is left alone and migrates paths itself. A LAN
socket with an iroh fallback is cancelled and reconnected at once on the new network, which
fails in-flight transfers. A pending retry runs immediately and resets backoff.

## Timing

Not measured end to end. `docs/TRANSPORT-BENCH.md` reports 32 to 37 ms direct and about 315 ms
via a local relay, both on loopback. The LAN attempt has a 3 s connect timeout
(`WsClient.kt:31`), which is the worst case added before the iroh fallback. Expect well under a
couple of seconds to a usable session over the relay, with the direct path taking over after.
These real-network figures are an estimate.
