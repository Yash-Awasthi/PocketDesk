# 0003. Permissions

**Status:** accepted
**Date:** 2026-11-26

## Context

Pairing starts with a token. The daemon generates 24 random bytes when no token exists (daemon/src/config.js:40). The config file is written with mode 0600 because it holds that token (daemon/src/config.js:84, daemon/src/config.js:96).

Each paired device gets its own token. The registry is a map keyed by client id (daemon/src/devices.js:19). Issuing a token stores only its hash (daemon/src/devices.js:74-82). `byToken` compares with `crypto.timingSafeEqual` (daemon/src/devices.js:92-95). `revoke` marks the device revoked and deletes its stored hash (daemon/src/devices.js:111-120). A live socket for a revoked device is closed with code 4003 and reason `device revoked` (daemon/src/server.js:446). Revoking on the pair page also rotates the pairing token, because the revoked device knew it too (daemon/src/server.js:240-241).

The authentication order is fixed. Nothing but `hello` is answered before authentication (daemon/src/server.js:359). A token that matches neither the master token nor a device token closes 4003 with `bad token` (daemon/src/server.js:395). A device that connects over iroh with the wrong endpoint key closes 4003 with `device key mismatch` (daemon/src/server.js:376). The per-connection password is checked only after a valid token, so a close code never tells a guesser whether the password was right (daemon/src/server.js:463). The password is stored as a scrypt record (daemon/src/access.js:10-13) and verified on every hello (daemon/src/access.js:4-8, daemon/src/access.js:55).

Two optional gates sit on top. Two-factor pairing is an RFC 6238 code with a 30 second step (daemon/src/totp.js:1); a new device that needs it closes 4011 (daemon/src/server.js:366), and a missing password closes 4012 (daemon/src/server.js:370). Devices already paired log in with their own token and are not asked (daemon/src/totp.js:2).

The PC owner holds two switches. When control is paused, a phone may only look: control messages outside the read, view, refuse, and stop set are refused with `<msg>: control is paused on the PC` (daemon/src/server.js:60, daemon/src/server.js:486). When remote access is off, a new socket closes 4100 with `remote access is switched off on the PC` (daemon/src/server.js:331). Both switches are driven from the pair page through `/access/control` (daemon/src/server.js:221) and `/access/remote` (daemon/src/server.js:223), persisted by `setControlAllowed` and `setRemoteOn` (daemon/src/access.js:28-41), and stored in the config file (daemon/src/config.js:93-94).

## Decision

1. The pairing token is the root credential. It is generated on first run (daemon/src/config.js:40), stored only in the 0600 config file (daemon/src/config.js:84), and used to pair a device once.
2. Every paired device gets its own token. Only the hash is stored (daemon/src/devices.js:78), and comparison is timing-safe (daemon/src/devices.js:94).
3. Revoking a device drops its hash, closes its socket with 4003 (daemon/src/server.js:446), and rotates the pairing token (daemon/src/server.js:241).
4. The gate order is hello, token, password, two-factor when a new device pairs, then the iroh endpoint claim (daemon/src/server.js:359-376, daemon/src/server.js:463, daemon/src/server.js:366).
5. The control gate and the remote switch are enforced per message and per socket (daemon/src/server.js:486, daemon/src/server.js:331), and both persist in the config file (daemon/src/config.js:93-94).
6. Machine-owner policy is not part of the accepted decisions in this ADR. It is recorded as proposed below.

## Consequences

- A leaked pairing token is not a permanent shared credential: revoking the device that used it rotates the token (daemon/src/server.js:241).
- A stolen device token stops working when the device is revoked or its credential generation changes (daemon/src/devices.js:111-120, daemon/src/server.js:399-400).
- Turning control off does not disconnect a viewer; control messages outside the view-only allowlist get an error (daemon/src/server.js:486).
- Turning remote access off closes live sockets with 4100 (daemon/src/server.js:331, daemon/src/server.js:539).
- Enabling two-factor does not disturb existing paired phones, which authenticate with their own tokens (daemon/src/totp.js:2, daemon/src/devices.js:78).
- The password check cannot be probed without a valid token, because it runs after token validation (daemon/src/server.js:463).

## Alternatives considered

- One shared pairing token for every phone. Not chosen: each device gets its own token so one device can be revoked without repairing the rest (daemon/src/devices.js:74-82).
- Token only, no per-connection password. Not chosen as the default: with no password the pairing token alone is full remote control forever, which the config loader warns about (daemon/src/config.js:73-74).
- Enforcing machine-owner policy now. Not accepted in this ADR; it is proposed below and is not implemented.

## Proposed: machine-owner policy

**Status note:** the accepted decisions above do not include this section. Nothing below is implemented or enforced by any shipped build.

The specification is a machine policy checked before any remote sense starts, with keys under `HKLM\SOFTWARE\PocketDesk\Policy` and a parallel `C:\ProgramData\PocketDesk\policy.json` (docs/INTEGRITY.md:213-225). The plan still lists the store and the enforcement as open items (plan.md:398-401). The setup guide names Application event 1003 as `a remote sense was refused by policy` in a table that applies policy refusals once machine policy is added (docs/SETUP-PC.md:131-142). The event ids are only wired in `eventlog.js`; nothing emits them yet and M6.1 owns the call site (plan.md:116).

No shipped build reads `HKLM\SOFTWARE\PocketDesk\Policy` or `C:\ProgramData\PocketDesk\policy.json`, and no shipped build returns a `disabled_by_policy` reason. A search of the tree on 2026-11-26 found neither string in source; the HKLM reads found in the tree are Smart App Control keys (daemon/scripts/install-service.ps1:29, and install.ps1:186 at the repository root).

The acceptance test for a future implementation:

1. The daemon refuses the feature before any remote sense starts (docs/INTEGRITY.md:213-214).
2. The refusal carries a visible `disabled_by_policy` reason that names the key (docs/INTEGRITY.md:224, plan.md:401).
3. The refusal writes Application event 1003 (docs/SETUP-PC.md:142).

## References

- daemon/src/config.js:40, daemon/src/config.js:73-74, daemon/src/config.js:84, daemon/src/config.js:93-96
- daemon/src/devices.js:19, daemon/src/devices.js:74-82, daemon/src/devices.js:92-95, daemon/src/devices.js:111-120
- daemon/src/server.js:221, daemon/src/server.js:223, daemon/src/server.js:240-241, daemon/src/server.js:331, daemon/src/server.js:359, daemon/src/server.js:366-370, daemon/src/server.js:376, daemon/src/server.js:395, daemon/src/server.js:446, daemon/src/server.js:463, daemon/src/server.js:486, daemon/src/server.js:539
- daemon/src/access.js:4-8, daemon/src/access.js:10-13, daemon/src/access.js:28-41, daemon/src/access.js:55
- daemon/src/totp.js:1-2, daemon/src/totp.js:25-80
- docs/INTEGRITY.md:213-225
- docs/SETUP-PC.md:142
- plan.md:116, plan.md:398-401
