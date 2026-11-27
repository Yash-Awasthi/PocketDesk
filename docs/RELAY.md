# Self-hosted iroh relay

The phone reaches the PC with iroh: a hole-punched QUIC path when both networks
allow it, and an end-to-end encrypted relay when they do not
(daemon/src/iroh_link.js:1-4). By default the endpoint uses n0's public relays
plus discovery through `applyN0` (daemon/src/iroh_link.js:33-37, 56-66). Those
relays belong to a third party and are rate-limited, so treat them as a
development path. A relay you run yourself removes that dependency: a custom URL
list contacts only the relays you name, and `"relays": "off"` turns relay mode
off entirely.

The relay sees endpoint ids, timing and volume, but not payload: the QUIC session
is encrypted to the PC's endpoint key (docs/THREAT-MODEL.md:161-167).

## What `iroh.relays` accepts

The daemon reads `config.json` from its state directory, `~/.pocketdesk` on
POSIX and `%USERPROFILE%\.pocketdesk` on Windows; `RH_HOME` relocates that
directory (daemon/src/config.js:9-12).

- Missing or `[]`: n0's public relays and discovery (daemon/src/iroh_link.js:63).
- A non-empty array of URLs: only those relays, through `customFromUrls`
  (daemon/src/iroh_link.js:60-62).
- `"off"`: no relay mode, direct paths only (daemon/src/iroh_link.js:57-59).

Selection order in `loadConfig` (daemon/src/config.js:75-94):

1. `RH_IROH=0` turns iroh off entirely; no endpoint starts (daemon/src/config.js:81).
2. `RH_IROH=local` sets the relay mode to `"off"` (daemon/src/config.js:83-84).
3. `"relays": "off"` in `config.json` also means direct only (daemon/src/config.js:85-86).
4. `RH_IROH_RELAYS` is split on commas, trimmed, and empty entries dropped
   (daemon/src/config.js:87-90). It wins over the array in the file.
5. Otherwise an array in `config.json` is used as-is (daemon/src/config.js:91-92).
6. Anything else, including an absent value, becomes `[]`, which selects n0
   (daemon/src/config.js:93).

`saveConfig` writes `"off"` back as `"off"`, preserves a URL array, and turns any
other value into `[]` (daemon/src/config.js:120-123). A typo such as
`"relays": "of"` therefore does not fail loudly: the next save drops it and the
PC falls back to n0. Editing the file by hand and restarting avoids that save.

## What the relay host needs

- A small Linux VPS with a public IP. A few devices do not need much CPU or RAM.
- A DNS name that points at that IP, for example `relay.example.com`, with an A
  and/or AAAA record.
- TCP 443 reachable from the internet, since that is where clients dial the
  relay.
- TCP 80 only if the certificate mode you choose issues certificates over
  HTTP-01.
- No UDP port by default. If you enable QUIC address discovery in the relay
  configuration, open the UDP port that configuration names, in both the relay
  and the VPS firewall.

## Install

Get the `iroh-relay` release for your platform from its own release page, unpack
it, and install the binary. Archive layout, TOML keys and CLI flags are specific
to that release, so confirm each name against the documentation shipped with it
rather than against this page. The commands below are the shape of the job.

```sh
sudo install iroh-relay /usr/local/bin/
sudo mkdir -p /etc/iroh-relay /var/lib/iroh-relay
```

`/etc/iroh-relay/relay.toml`, a starting point:

```toml
[tls]
cert_mode = "LetsEncrypt"
hostname = "relay.example.com"
contact = "you@example.com"
cert_dir = "/var/lib/iroh-relay"

# Optional. Without an allowlist the relay forwards for any endpoint that
# presents a ticket; the pairing token still gates commands.
[access]
allowlist = [
  "<pc endpoint id>",
  "<phone endpoint id>",
]
```

The allowlist is what restricts the relay to your endpoint ids. Leave it out and
the relay will forward for any endpoint that presents a ticket
(docs/THREAT-MODEL.md:186-187); every command still needs the phone token, but
the relay itself is open. The PC's endpoint id is the `iroh      <endpoint id>`
line printed at daemon start (daemon/src/server.js:1412). A phone's endpoint id
appears in the device list after it has connected once
(daemon/src/devices.js:131-139, 160-166).

`/etc/systemd/system/iroh-relay.service`:

```ini
[Unit]
Description=iroh relay
After=network-online.target

[Service]
ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay/relay.toml
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now iroh-relay
```

## Point PocketDesk at it

In `%USERPROFILE%\.pocketdesk\config.json` on the PC, inside the existing object:

```json
"iroh": { "enabled": true, "relays": ["https://relay.example.com"] }
```

The config file is read when the daemon starts (daemon/src/config.js:14-94,
daemon/src/server.js:1388-1391), so restart the daemon after saving. Then open
the hub on the PC itself, at the address printed in the startup block
(daemon/src/server.js:1367-1384), and use the QR on its This PC page: there is no
separate pairing document any more (daemon/src/server.js:247-266, 468-477).

The ticket inside the QR is built from the endpoint's current address
(daemon/src/iroh_link.js:91), so after the restart it carries the new relay URL.
The app dials the address it is given (daemon/src/iroh_link.js:177-183), which
means it dials that relay. A phone still holding the old QR keeps the old
address, so re-scan it.

A newly added phone can reach the PC over a direct path before its endpoint id
is in the allowlist, because the allowlist only governs relay forwarding. Add
the id and restart the relay to give it the relay too.

## When the relay is unreachable

The relay is a fallback, not a requirement. iroh first tries a direct,
hole-punched QUIC path between the phone and the PC, and the relay only carries
traffic when no direct path forms (daemon/src/iroh_link.js:1-4). A dead or
blocked relay therefore leaves direct connections working, and only the cases
that truly needed a relay fail.

The daemon logs the selected path 8 seconds after a connection is accepted, as
`iroh      <8 chars> relayed|direct, rtt N ms` (daemon/src/server.js:1395-1401).
The phone shows the same path, refreshed every few seconds, as `direct 42 ms` or
`relayed 80 ms` (app/app/src/main/java/com/yasha/pocketdesk/IrohLink.kt:40, 64).
Those two lines tell you which half is in play, without guessing.

A failed attempt is worth one retry: hole punching sometimes succeeds on the
second try. If it keeps failing, restart the daemon so it rebuilds the endpoint.

Without any iroh, the PC's own page still works on loopback, and the LAN page
still works when TLS is on (daemon/src/server.js:519-523, 1356-1359).

To stop the PC from trying a dead relay at all, run it direct-only. In
`%USERPROFILE%\.pocketdesk\config.json` on the PC:

```json
"iroh": { "enabled": true, "relays": "off" }
```

Restart the daemon after saving. For a single run, `RH_IROH=local` does the same
without editing the file (daemon/src/config.js:83-84). Direct-only still reaches
the PC whenever a direct path exists; it just never falls back to a relay.

## Checks on a self-hosted relay

- `systemctl status iroh-relay` shows the service running, not restarting.
- A TLS request to the relay name from another machine completes, which proves
  TCP 443 and the certificate.
- If you use an allowlist, the PC's and phone's endpoint ids are both in it, and
  the relay was restarted after the last edit.
- The TLS certificate is current; certificate issuance needs the port your
  chosen mode uses.

## Tickets and the endpoint key

The endpoint key is `iroh.key` in the state directory, written with mode 0600 the
first time and reused afterwards (daemon/src/iroh_link.js:47-54). The endpoint id
is derived from that key, so it stays the same across restarts.

The ticket is built from the endpoint's address (daemon/src/iroh_link.js:91),
which carries the endpoint id, the relay URL, and the current addresses. Changing
the relay list therefore changes the ticket: restart the daemon so the new
address is bound, then re-scan the newly rebuilt QR on the phone. An old ticket
still points at the relay and addresses it was built with.

Verified against daemon/src/iroh_link.js:33-66 (relay branches, key file, ticket) and 108-192 (keepalive, dial pin, timeout), daemon/src/config.js:75-94 and 120-123 (relay selection, save round-trip), and daemon/src/server.js:466-477, 519-538 and 1387-1415 (pair page, loopback listeners, iroh start block and path log).
