# 0001. Protocol changes

**Status:** accepted
**Date:** 2026-11-26

## Context

The daemon answers a message by looking its type up in a handler map: `const h = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;` (daemon/src/server.js:484). Each module under `daemon/src/handlers/` is a factory that returns a message-keyed object (CONTRIBUTING.md:279-281). The phone keeps its own copy of the message definitions in `app/app/src/main/java/com/yasha/pocketdesk/Protocol.kt` (CONTRIBUTING.md:282).

The message table in `daemon/README.md` sits between `<!-- BEGIN protocol-table -->` (daemon/README.md:22) and `<!-- END protocol-table -->` (daemon/README.md:252). It is generated, has one row per message type, and currently covers 222 types (daemon/README.md:24). The generator rewrites the table with no arguments and exits 1 with `--check` when the table is stale (daemon/scripts/gen-protocol-doc.mjs:9-11). `daemon/test/protocol-doc.test.mjs` runs the `--check` form (daemon/scripts/gen-protocol-doc.mjs:11).

## Decision

1. A protocol change lands on both ends in one change: the daemon handler map and the phone's `Protocol.kt` (CONTRIBUTING.md:277-282).
2. The generated table is regenerated in the same change (CONTRIBUTING.md:284-290).
3. Both protocol tests stay current in that change: `daemon/test/protocol-doc.test.mjs` and `daemon/test/protocol-contract.test.mjs` (CONTRIBUTING.md:292-295).
4. The check is expected to be green on every accepted change. Running `node daemon/scripts/gen-protocol-doc.mjs --check` on 2026-11-26 printed `protocol table is current (222 message types)` and exited 0; the success line is the one at daemon/scripts/gen-protocol-doc.mjs:92.

5. Adding a message is additive: it takes no protocol version bump, because a peer
   ignores a type it does not know. The README list and `daemon/protocol/compat.json` grow in
   the same change (`node daemon/scripts/gen-protocol-compat.mjs`).
6. Removing or renaming a message, or changing the fields the README documents for it, needs
   the `Protocol (vN)` heading in README.md bumped and a `- vN:` line under
   "Compatibility notes" below that names each affected type.
7. `node daemon/scripts/gen-protocol-compat.mjs --check` is the gate for both rules: it fails
   on a stale baseline, and on a removal or field change that lacks the bump and the note.
   `daemon/test/protocol-doc.test.mjs` runs it.

## Consequences

- The contract test is the app-to-daemon check that must stay current in the same change (CONTRIBUTING.md:293-295).
- The README table is not edited by hand; its row count follows the registry (daemon/README.md:24).
- The phone definitions live in `Protocol.kt`, so the app side must carry the matching change (CONTRIBUTING.md:282).
- Any future protocol version field or handshake must itself come through a new ADR, because dispatch currently reads only `msg.type` (daemon/src/server.js:484).

## Compatibility notes

One line per version whose removal or field change a shipped client could notice. A purely
additive version has no line, because nothing that was already sent changes meaning.

- v1: initial baseline, the 226 message types README.md listed at the time and now
  recorded in `daemon/protocol/compat.json`. Later additions took no version bump.
- v2: `hello` may carry an optional integer `protocolVersion`. A daemon on v2 answers a
  different value with `protocol_mismatch {expected, found}` and closes with 4026; a hello
  that omits the field is still accepted as an older client.

## Alternatives considered

- Hand-maintaining the README table. Not chosen: the generator exists and `--check` fails on drift (daemon/scripts/gen-protocol-doc.mjs:9-11).
- A version negotiation between app and daemon. Not adopted now: dispatch has no version field (daemon/src/server.js:484), and the contract test compares the two sides directly (CONTRIBUTING.md:293-295).
- A separate message set per transport. Not chosen: the iroh link exposes a ws-compatible surface (daemon/src/iroh_link.js:213), so one message layer serves both paths.

## References

- daemon/src/server.js:484
- daemon/src/handlers/
- daemon/README.md:22, daemon/README.md:24, daemon/README.md:252
- daemon/scripts/gen-protocol-doc.mjs:1-11
- daemon/test/protocol-doc.test.mjs
- daemon/test/protocol-contract.test.mjs
- app/app/src/main/java/com/yasha/pocketdesk/Protocol.kt
- CONTRIBUTING.md:275-298
