# Architecture Decision Records

An ADR records a decision that is expensive to reverse. The records here cover the wire protocol, the transports, and the authentication and permission gates.

## When an ADR is required

Write an ADR before merging any of these:

- A protocol change: a new or changed message type, field, or close code. The daemon dispatches on `handlers[msg.type]` (daemon/src/server.js:484), and the change rule is stated in CONTRIBUTING.md:275-295.
- A transport change: how a phone or browser reaches the daemon, or how bytes are protected in transit (daemon/src/config.js:41-52, daemon/src/iroh_link.js:1-6).
- A new permission or authentication gate, or a change to the order in which gates are checked (daemon/src/server.js:359, daemon/src/access.js:4-8).

## Numbering

Numbers are four digits, start at 0001, and increase by one. A number is never reused and never renumbered. A decision that replaces an earlier one gets a new number; the earlier record's status becomes `superseded` and its text stays as written.

## Status values

- `proposed`: written down, not yet agreed or built.
- `accepted`: the current decision.
- `superseded`: replaced by a later ADR; the replacement is named in the old record.

## Template

```markdown
# 000N. Title

**Status:** accepted
**Date:** YYYY-MM-DD

## Context

## Decision

## Consequences

## Alternatives considered

## References
```

## Index

| Number | Title | Status | Link |
|---|---|---|---|
| 0001 | Protocol changes | accepted | [0001-protocol-changes.md](0001-protocol-changes.md) |
| 0002 | Transport | accepted | [0002-transport.md](0002-transport.md) |
| 0003 | Permissions | accepted | [0003-permissions.md](0003-permissions.md) |
| 0004 | node-pty pin | accepted | [0004-node-pty-pin.md](0004-node-pty-pin.md) |

## Wording

This directory is under the same wording rule as the rest of the tree. `daemon/test/no-evasion.test.mjs` lists the banned patterns at daemon/test/no-evasion.test.mjs:10-18, and its walk at daemon/test/no-evasion.test.mjs:25-36 covers the repository's `.md`, `.js`, `.mjs`, `.cs`, `.ps1` and `.kt` files (daemon/test/no-evasion.test.mjs:23), so the rule applies to an ADR exactly as it applies to code and comments.
