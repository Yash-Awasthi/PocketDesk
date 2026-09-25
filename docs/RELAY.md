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
