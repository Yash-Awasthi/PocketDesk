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

## Plain ws:// is refused

Plaintext never leaves the PC. A daemon without TLS (certificate generation failed, or
`tls.enabled` set to false) accepts sockets from loopback only. The app refuses `ws://` entries:
a pairing QR without TLS yields an iroh-only entry when it carries an iroh ticket, and an older
saved `ws://` entry connects over its iroh fallback or asks the user to re-scan the QR.

## Android 17 local network access

Apps targeting Android 17 (SDK 37) need the `ACCESS_LOCAL_NETWORK` runtime permission to open any
socket to a LAN address. Without it the system drops the SYN silently, the LAN dial times out after
3 s and the app falls back to iroh, so a phone on the PC's own Wi-Fi still ends up on the relay.
The app declares the permission and asks for it at first launch and again before a connect.

## Behaviour on network change

`WsClient.onNetworkChanged` runs for every change of the default network (Wi-Fi, mobile data,
Ethernet). Android denies iroh the netlink socket it watches interfaces with, so the iroh endpoint
never learns about the change and keeps sockets bound to the old network. On a change the app
therefore marks its endpoints stale (`IrohLink.Node.networkChanged`), cancels the LAN socket and the
iroh link alike, fails in-flight transfers and redials at once with backoff reset; the next iroh
dial binds a fresh endpoint. An iroh connect gives up after 15 s and hands over to the retry loop.

`ConnectRoute.pick` chooses the address: the LAN url on Wi-Fi or Ethernet, iroh on mobile data and
on a Wi-Fi where the LAN url already failed. When the iroh attempt fails as well, the PC itself is
down rather than off this LAN, so the LAN pin is cleared and retries alternate again; a PC that
comes back after a restart is reached on its LAN address instead of staying on the relay.

## Timing

Not measured end to end. `docs/TRANSPORT-BENCH.md` reports 32 to 37 ms direct and about 315 ms
via a local relay, both on loopback. The LAN attempt has a 3 s connect timeout
(`WsClient.kt:31`), which is the worst case added before the iroh fallback. Expect well under a
couple of seconds to a usable session over the relay, with the direct path taking over after.
These real-network figures are an estimate.
