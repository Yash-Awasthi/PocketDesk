# 0002. Transport

**Status:** accepted
**Date:** 2026-11-26

## Context

The daemon has three network paths.

The LAN path uses TLS when it is enabled. `cfg.tls` holds `enabled`, `cert`, and `key` (daemon/src/config.js:42-46). The token crosses the LAN in the clear until TLS is on, so a self-signed certificate is generated when none exists and TLS is switched on (daemon/src/config.js:47-52). The certificate is built in process with `node:crypto` and a minimal DER encoder (daemon/src/tls-gen.js:1-8). `npm run setup-tls` runs `node scripts/gen-cert.js` (daemon/package.json:14).

The PC's own browser uses a plain HTTP page bound to loopback. Its port is the main port plus ten (daemon/src/server.js:313), and it listens on `127.0.0.1` (daemon/src/server.js:317). The loopback page is offered only when the daemon signs a nonce with the token: `/prove?` is loopback only (daemon/src/server.js:190), it answers with an HMAC of the nonce keyed by the token (daemon/src/server.js:193), and the CLI builds the HMAC the same way (daemon/src/cli.js:50). The loopback URL is used only when the answer matches; otherwise the URL points at the daemon's own port (daemon/src/cli.js:53).

Phones outside the LAN use iroh: a direct hole-punched QUIC path with an end-to-end encrypted relay fallback (daemon/src/iroh_link.js:1-4). The relay setting is `"off"` for direct-only, a list of relay URLs for self-hosted relays, or empty for the public relays and discovery (daemon/src/iroh_link.js:33-35). `RH_IROH=0` disables iroh, `RH_IROH=local` keeps it direct-only, and `RH_IROH_RELAYS` takes a comma-separated list (daemon/src/config.js:60-68).

`@number0/iroh` is an optional dependency (daemon/package.json:28). At startup the daemon prints the endpoint id (daemon/src/server.js:956), prints `unavailable (optional @number0/iroh not installed)` when the binding is missing (daemon/src/server.js:952), prints `failed to start: <msg>` on a failure (daemon/src/server.js:957), and prints `relayed` or `direct` with an RTT per peer (daemon/src/server.js:945).

## Decision

1. LAN links use TLS with a self-signed certificate that the daemon generates on first run when the file is absent (daemon/src/config.js:49-52). An operator can generate it explicitly with `npm run setup-tls` (daemon/package.json:14).
2. The PC browser gets the loopback URL on the main port plus ten (daemon/src/server.js:313) only after the nonce proof succeeds; otherwise it gets the daemon's own URL (daemon/src/cli.js:50-53).
3. Off-LAN links use iroh QUIC with a direct path and an encrypted relay fallback (daemon/src/iroh_link.js:1-4). Relay selection follows `RH_IROH` and `RH_IROH_RELAYS` (daemon/src/config.js:60-68).
4. iroh is optional. When the binding is missing the daemon logs the unavailable line and starts without that path (daemon/src/server.js:952).
5. Both paths feed one message layer, because an iroh connection is wrapped in a ws-compatible surface (daemon/src/iroh_link.js:213).

## Consequences

- Without TLS, non-loopback connections are dropped (daemon/src/server.js:283), for the reason in the comment above that line (daemon/src/server.js:282).
- The generated certificate is self-signed, so no public CA issued it (daemon/src/tls-gen.js:40).
- The loopback page never leaves `127.0.0.1` (daemon/src/server.js:317), so it cannot be reached from the LAN.
- The public relays are rate-limited and meant for development; a self-hosted relay removes the dependency and then nothing contacts the public service (docs/RELAY.md:3-7).
- A missing optional binding costs off-LAN access only (daemon/src/server.js:952).

## Alternatives considered

- Plaintext on the LAN. Refused: plaintext would put the token and every byte on the LAN in the clear, so without TLS every non-loopback connection is dropped (daemon/src/server.js:282-283).
- The public relays as the production path. Not chosen: they are rate-limited and meant for development, while a self-hosted relay removes the dependency (docs/RELAY.md:3-7).
- A second transport protocol with its own message framing. Not chosen: the iroh connection is wrapped as a ws-compatible socket (daemon/src/iroh_link.js:213), so the message layer is shared.

## References

- daemon/src/config.js:41-52
- daemon/src/tls-gen.js:1-8
- daemon/package.json:14
- daemon/src/server.js:190, daemon/src/server.js:193, daemon/src/server.js:313, daemon/src/server.js:317, daemon/src/server.js:945, daemon/src/server.js:952, daemon/src/server.js:956, daemon/src/server.js:957
- daemon/src/cli.js:50-53
- daemon/src/iroh_link.js:1-6, daemon/src/iroh_link.js:33-35, daemon/src/iroh_link.js:213
- daemon/src/config.js:60-68
- daemon/test/iroh.test.mjs
- daemon/test/plaintext-loopback.test.mjs
- daemon/test/tls-gen.unit.test.mjs
- docs/RELAY.md:3-7
