# 0004. node-pty pin

**Status:** accepted
**Date:** 2026-11-26

## Context

The daemon's terminal layer uses `node-pty`. The dependency is pinned to `"1.1.0"` (daemon/package.json:20), and the install-script allowlist names the same version (daemon/package.json:24-25).

The plan's measured dependency table recorded `node-pty 1.2.0-beta.15` (plan.md:40). The task asked for either a stable pin or the beta vendored with an ADR that states the risk and the exit condition (plan.md:140). The verification with 1.1.0 spawned a PTY and printed `PTY_OK seen`; the terminal, stream, and crash suites passed, and a clean `npm ci` also passed (plan.md:141). The move was from the beta line to 1.1.0, which is the `latest` dist-tag; the 1.2 line still ships betas only, at `1.2.0-beta.18` (plan.md:142). Version 1.1.0 publishes win32-x64 and darwin N-API prebuilds, so no compiler is needed and Node 26 loads it unchanged (plan.md:142).

## Decision

1. Pin `node-pty` to 1.1.0 (daemon/package.json:20).
2. Allow the install script for exactly `node-pty@1.1.0` (daemon/package.json:24-25).
3. Do not change any conpty option. No `useConpty*` option is used anywhere in the tree; the only mention of the string is the note in plan.md:143.
4. Reopen this decision if a conpty bug appears on a real desktop (plan.md:143).

## Consequences

- The stable major is used, so the dependency no longer tracks a beta line (plan.md:142).
- The Windows conhost fixes that exist only in the 1.2 betas are given up (plan.md:143).
- The package installs from prebuilt N-API binaries, so a native compiler is not part of the build (plan.md:142).
- Terminal behavior follows the package defaults, because the tree passes no conpty option (plan.md:143).
- A conpty bug on real desktop hardware is the trigger to revisit the pin (plan.md:143).

## Alternatives considered

- Keep `1.2.0-beta.15` (plan.md:40). Not chosen: it is a beta, and the task asked for a stable release unless the beta was vendored with a recorded risk (plan.md:140).
- Move to `1.2.0-beta.18` (plan.md:142). Not chosen: the 1.2 line still ships betas only (plan.md:142).
- Build from source. Not needed: 1.1.0 publishes win32-x64 and darwin N-API prebuilds, so no compiler is required (plan.md:142).

## References

- daemon/package.json:20, daemon/package.json:24-25
- plan.md:40
- plan.md:140-143
