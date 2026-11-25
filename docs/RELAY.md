# Self-hosted iroh relay

The phone reaches the PC with iroh: a direct, hole-punched QUIC path when the two
networks allow it, and an end-to-end encrypted relay when they do not. By default
both ends use n0's free public relays, which are rate-limited and meant for
development. A relay you run yourself removes that dependency; nothing then
contacts n0 at all.

The relay only ever sees encrypted packets, and it only forwards traffic for the
endpoint IDs you allow.

## What you need

- A small Linux VPS with a public IP (1 vCPU and 512 MB are plenty for a few devices).
- A DNS name pointing at it, e.g. `relay.example.com` (A and/or AAAA record).
- Open ports: TCP 80 (certificate issuance), TCP 443 (relay), UDP 7842 (address discovery).

## Install

Use `iroh-relay` 1.0.2 or later; 1.0.2 fixed a pre-auth crash.

```sh
curl -LO https://github.com/n0-computer/iroh/releases/download/v1.2.0/iroh-relay-v1.2.0-x86_64-unknown-linux-musl.tar.gz
tar xzf iroh-relay-v1.2.0-x86_64-unknown-linux-musl.tar.gz
sudo install iroh-relay /usr/local/bin/
sudo mkdir -p /etc/iroh-relay /var/lib/iroh-relay
```

`/etc/iroh-relay/relay.toml`:

```toml
enable_quic_addr_discovery = true

[tls]
cert_mode = "LetsEncrypt"
hostname = "relay.example.com"
contact = "you@example.com"
cert_dir = "/var/lib/iroh-relay"

# Only your devices may use the relay. The PC's ID is printed at daemon start
# ("iroh <id>"); each paired phone's ID is the endpointId in the device list.
[access]
allowlist = [
  "<pc endpoint id>",
  "<phone endpoint id>",
]
```

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

In `%USERPROFILE%\.pocketdesk\config.json` on the PC:

```json
"iroh": { "enabled": true, "relays": ["https://relay.example.com"] }
```

Restart the daemon and pair the phone again from `/pair`. The QR's ticket names
the new relay, and the app uses that relay too, so neither end contacts n0.

A new phone needs its endpoint ID added to `allowlist` and a relay restart before
it can use the relay. While it is not allowed, it still connects whenever a
direct path exists.

## When the relay is unreachable

The relay is a fallback, not a requirement. iroh first tries a direct,
hole-punched QUIC path between the phone and the PC; the relay only carries the
traffic when no direct path can be built. So a dead or blocked relay leaves
direct connections working, and only the cases that genuinely needed the relay
fail.

After a connection is up, the daemon logs the path it took, either
`iroh <id> direct` or `iroh <id> relayed`, and the phone shows the same path
once it is connected. That line tells you which half is in play.

If a connection fails, wait a few seconds and try again: iroh retries and may
find a direct path on the second attempt. If it keeps failing, restart the
daemon so both ends rebuild their endpoints. When iroh cannot connect at all,
the same-machine and LAN page still works on the PC's own addresses, so local
access is never blocked by the relay.

To stop the PC from contacting a dead relay at all, run it direct-only. In
`%USERPROFILE%\.pocketdesk\config.json` on the PC:

```json
"iroh": { "enabled": true, "relays": "off" }
```

Restart the daemon after saving. For a single run, `RH_IROH=local` does the
same without editing the file. Direct-only still reaches the PC whenever a
direct path exists; it just never falls back to a relay.

When you self-host, check these on the server:

- `systemctl status iroh-relay` shows the service running, not restarting.
- TCP 443 is open to the internet, and so is UDP 7842 for address discovery.
- The PC's and phone's endpoint IDs are both in `allowlist`.
- The TLS certificate has not expired (Let's Encrypt renewals need TCP 80 open).

The public n0 relays are rate-limited and meant for development, so
intermittent relay failures on the free tier are expected. Self-hosting a relay
or running direct-only is the fix; retrying the same public relay will not make
it reliable.

The QR ticket keeps working when you change or lose the relay, because it names
the endpoint, not the relay.
