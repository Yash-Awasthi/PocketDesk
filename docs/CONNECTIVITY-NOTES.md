# Connectivity and security notes

How the phone finds the PC, how the iroh fallback works, what is encrypted and authenticated,
why plaintext is refused, and what happens across network changes and Android versions. Every
claim below names the file and line it comes from; the paragraph at the end lists the main
sources.

## How the phone finds the PC

The pairing QR carries a base64url JSON payload `{u,t,f,i,n}` under `pocketdesk://pair#`
(`daemon/src/server.js:271-281`). The fields are:

- `u`: the LAN url, `wss://<lanAddress>:<port>/ws` once TLS is on (`server.js:270`).
- `t`: the master token (`server.js:274`).
- `f`: the certificate fingerprint, empty without TLS (`server.js:275`, `1362-1365`).
- `i`: the current iroh ticket, omitted while there is none (`server.js:276`).
- `n`: the label from `RH_LABEL`, omitted when unset (`server.js:277`).

The address in `u` comes from `lanAddress()`, which prefers `192.168.x`, then `10.x`, then
`172.16/12`, then any non-link-local IPv4, and falls back to `localhost`
(`server.js:233-239`). The order matters because a VPN or Tailscale adapter also sits on a
private range and would otherwise be picked first, making the QR unreachable
(`server.js:229-231`).

The app parses the same fields (`app/.../Pairing.kt:28-36`). `u` and `t` are required. A
`wss://` url becomes a LAN entry with the pinned fingerprint and the iroh ticket as its
fallback (`Pairing.kt:36`). A `ws://` url with no ticket yields nothing, and with a ticket it
yields an iroh-only entry (`Pairing.kt:34`).

`ConnectRoute.pick` chooses the address for an entry that has both (`ConnectRoute.kt:11-18`):

1. No fallback: the LAN url (`ConnectRoute.kt:14`).
2. Mobile data, reported as `!net.local`: iroh (`ConnectRoute.kt:15`).
3. A Wi-Fi or Ethernet where the LAN url already failed: iroh (`ConnectRoute.kt:16`).
4. Anything else: the LAN url (`ConnectRoute.kt:17`).

The failed-network rule is recorded and cleared in the reconnect handler. A failed LAN url is
pinned to the current network id (`WsClient.kt:1452`); a failed fallback clears the pin, so the
next retries alternate between LAN and iroh again (`WsClient.kt:1449-1453`). Both failing means
the PC itself is down rather than off this LAN, so a PC that comes back is reached on its LAN
address instead of staying on the relay (`WsClient.kt:1449-1453`).

A phone on a USB cable arrives through `adb reverse`, which reaches a separate listener on
`port + 30` bound to `127.0.0.1` (`server.js:524-538`). It arrives from loopback but is marked
`_usb`, so it is not granted the loopback-only pages (`server.js:323`, `530-535`).

## The iroh path

iroh addresses the PC by public key instead of IP, so no VPN, port forward or inbound rule is
needed (`daemon/src/iroh_link.js:2-4`). The sequence:

1. The daemon keeps an endpoint key on disk as `iroh.key`, written with mode 0600
   (`iroh_link.js:47-54`).
2. The ticket is the endpoint's current address, produced from `ep.addr()`
   (`iroh_link.js:91`), so it carries the endpoint id, the relay url and the current addresses.
3. The phone dials that address, preferring the relay from the ticket (`IrohLink.kt:54-56`), so
   the QUIC handshake starts over the relay and a session can exist before a direct path forms
   (`iroh_link.js:2-4`).
4. Hole punching then runs: both sides learn their public address, exchange candidates and
   probe in parallel, and if a probe pair gets through, QUIC moves to the direct path with the
   same session (`iroh_link.js:3`).
5. If the NAT is symmetric or the phone sits behind carrier NAT, the probes miss and the
   session stays on the encrypted relay (`iroh_link.js:3-4`).

This is not port forwarding. No router setting changes and no inbound rule is added
(`iroh_link.js:2-4`); idle NAT and relay state is probed and a dead path is redialled
(`iroh_link.js:108-112`).

Both ends report where the traffic landed: the daemon logs `direct` or `relayed` plus the rtt
eight seconds after a connection (`server.js:1394-1401`), and the app reports the selected path
every few seconds (`IrohLink.kt:62-66`).

## Security properties

- Master token: 24 random bytes, 192 bits, generated per daemon (`daemon/src/config.js:51`) and
  compared with `timingSafeEqual` (`server.js:706`).
- Device tokens: stored as hashes and compared with `timingSafeEqual`
  (`daemon/src/devices.js:92-94`).
- Per-connection password: stored as a scrypt record, salt plus key (`daemon/src/access.js:10-13`),
  checked on every hello after the token (`access.js:5-6`, `server.js:710`) with a timing-safe
  compare (`access.js:50-56`). A leaked token alone is therefore not enough when a password is
  set.
- `remoteOn` is a master switch: when off, every client is closed, LAN and iroh alike
  (`access.js:22-25`, `server.js:543`).
- The control gate can force every viewer to view-only (`access.js:35-43`).
- LAN TLS: first run generates a self-signed EC P-256 certificate valid ten years
  (`daemon/src/tls-gen.js:41-46`) with `localhost`, the hostname, `127.0.0.1` and the LAN IPv4
  addresses in the SANs (`tls-gen.js:69-75`). The QR carries `wss://` and the fingerprint
  (`server.js:270`, `1362-1365`), and the app pins the leaf fingerprint, rejecting a mismatch
  (`app/.../Tls.kt:38-49`).
- iroh is encrypted end to end between the two endpoints (`iroh_link.js:2-4`). The QUIC session
  is encrypted to the PC's endpoint key and the phone checks the PC's signature against the key
  in the ticket (`docs/THREAT-MODEL.md:161-167`); the daemon pins the endpoint id when it dials
  another daemon and closes 4003 on a mismatch (`iroh_link.js:178-191`). On the accepting side
  the iroh endpoint does accept peers; the ws-layer hello then rejects them unless the token
  (and password, when set) checks out (`server.js:704-710`), and a device whose endpoint id
  changed is closed with 4003 (`server.js:596-599`, binding in `devices.js:127-139`).
- Relays see ciphertext, endpoint ids, timing and volume, and can drop or delay traffic, but not
  the payload (`docs/THREAT-MODEL.md:161-167`).

The ticket is an address, not a credential (`docs/THREAT-MODEL.md:166-167`). It gets a peer to
the endpoint; the hello and the device binding decide what that peer may do.

## Plain ws:// is refused

Plaintext is never accepted from the LAN. Without TLS the server binds `127.0.0.1` rather than
every interface (`server.js:1356-1359`) and a connection filter destroys any peer that is not
loopback (`server.js:486-490`). The other listeners are loopback as well: the local page on
`port + 10` (`server.js:519-523`), the USB listener on `port + 30` (`server.js:526-538`), the
CLI endpoint on 4679 (`daemon/src/cli-server.js:19`, `167`), the SSH bastion on 2223 by default
(`daemon/src/ssh_bastion.js:229`), and the advanced SSH server on its own configured port and
host (`daemon/src/advanced_ssh_server.js:246-255`).

The app never dials a `ws://` entry. A pairing QR with `ws://` gives an iroh-only entry when it
carries a ticket, and nothing when it does not (`Pairing.kt:29-34`). An older saved plaintext
entry either reconnects over its iroh fallback or is refused with a request to re-scan the QR
(`WsClient.kt:326-332`).

## Android 17 local network access

The app targets SDK 37 (`app/app/build.gradle.kts:25`) and declares `ACCESS_LOCAL_NETWORK`
(`app/app/src/main/AndroidManifest.xml:7`). It requests the permission at first composition
(`ui/ConnectScreen.kt:88-90`) and again before a connect (`ConnectScreen.kt:79-85`). When it is
not granted, a LAN connect cannot succeed: the attempt fails at its 3 s timeout, that network is
marked as failed and the phone lands on iroh (`WsClient.kt:31`, `WsClient.kt:1452`,
`ConnectRoute.kt:16`).

## Behaviour on network change

`WsClient.onNetworkChanged` runs when the default network changes (`WsClient.kt:353-365`). It
tells the iroh node the network changed (`WsClient.kt:356`), cancels the LAN socket and the
iroh link alike (`WsClient.kt:359-360`), pauses transfers, resets the retry policy and redials
at once (`WsClient.kt:362-364`). The iroh node's stale flag shuts down the old endpoints and
binds a fresh one on the next dial (`IrohLink.kt:189-205`). An iroh connect gives up after 15 s
and hands back to the reconnect loop (`IrohLink.kt:56`, `IrohLink.kt:212`, `WsClient.kt:27-31`).

The server side keeps its own liveness checks: the ws heartbeat pings every 30 s and terminates
a socket that missed the last pong (`server.js:639-653`), and the iroh link pings every 20 s and
closes when a ping goes 10 s unanswered (`iroh_link.js:111-112`).

Switching from a failed LAN url to iroh costs no backoff, since that is not a real failure
(`WsClient.kt:1459-1460`).

## Timing

The figures in `docs/TRANSPORT-BENCH.md:59` are loopback numbers under the conditions at
`TRANSPORT-BENCH.md:22-25`: connecting took 32 to 37 ms on a direct path, about 315 ms through
the local relay, and 2 ms for ws on loopback. The LAN attempt has a 3 s connect timeout
(`WsClient.kt:31`), which is the worst case added before the iroh fallback. End-to-end timing on
a real network, and a phone on mobile data, were not measured here (`TRANSPORT-BENCH.md:89-92`).

Verified against daemon/src/config.js:50-94, daemon/src/server.js:224-284 and 482-538 and 1356-1415, daemon/src/tls-gen.js:41-90, daemon/src/access.js:9-57, daemon/src/cli-server.js:19 and 167, daemon/src/ssh_bastion.js:229, daemon/src/iroh_link.js:33-192, and app/app/src/main/java/com/yasha/pocketdesk/{Pairing.kt:26-37,ConnectRoute.kt:11-18,WsClient.kt:27-31 and 353-365 and 1447-1469,IrohLink.kt:189-212,Tls.kt:38-49}.
