# PocketDesk — bug audit and enhancement plan

## What this document is

PocketDesk is the most mature project in this collection. At the time of the
audit it had a working test suite (`npm.cmd test` — 22 files, 202 checks, all
passing), a clean release build (`assembleDebug`), a clean working tree,
correctly ignored and untracked keystores, and a complete absorption record in
`docs/ABSORPTION-LEDGER.md` plus `docs/FEATURE-MATRIX.md`. The inspiration corpus
has already been processed end to end: the ledger's `🧩` (module present but
unwired) count is 0, and only `🗺️` roadmap items remain. The suite is 28 files and
304 checks as of the fixes in Part 6, and the working tree holds those fixes.

This document is therefore not a to-do list for absorbing features. It records
the defects found in a full audit of the source, the ledger, and the feature
matrix, and it sets out the remaining work in phases. The other projects in this
collection get a document covering both repair and absorption; PocketDesk
gets a document that is mostly repair, plus the residual roadmap that the ledger
already tracks.

Audit basis: 61 modules under `daemon/src/` (82 JavaScript files in `daemon/`
excluding `node_modules`), 19 Kotlin files under
`app/app/src/main/java/com/yasha/pocketdesk/`, 33 `.mjs` test files under
`daemon/test/` plus 8 JavaScript test files under `daemon/src/__tests__/`.

Two categories of finding were deliberately dropped after verification and are
not listed below. Apparent shell-injection sites in `freebuff_control.js:75`,
`power_manager.js:89`, and `chat.js:190` are not vulnerabilities: every input is
an internal constant or a value drawn from the manifest allowlist, and an
authenticated client can already run arbitrary commands by design, so a
"vulnerability" there would be a restatement of the feature. Empty `catch {}`
blocks in `audit-log.js`, `chat.js`, `devices.js`, `power_manager.js`,
`qr_session_sharing.js`, and elsewhere are best-effort cleanup of an optional
resource or an optional JSON parse; they are idiomatic in this codebase and do
not hide an error path that the caller needs.

---

## Part 1 — Defects

### 1. The relay brute-force gate is inverted, and it locks out honest peers — high

`daemon/src/server.js:1795-1817`.

The relay path (a peer publishes an `rhreq` envelope onto the relay channel; the
daemon replays the inner message through `handle()` via a shim WebSocket-like
object) has its own token check. The failure branch increments a counter and the
enforcement check sits below it:

```js
if (!shim._authed) {
  const t = typeof inner.token === "string" ? inner.token : "";
  const ok = inner.type === "hello" && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  if (!ok) {
    relayAuthFails.n += 1;                                    // :1802
    if (Date.now() - relayAuthFails.at > 10 * 60_000) relayAuthFails = { n: 1, at: Date.now() };
    relayPublish({ rh: true, type: "rherr", reqId: shim._currentReqId, error: "bad token" });
    relayShims.delete(evt.from);
    return;                                                   // :1806
  }
  shim._authed = true;
  ...
  return;
}
if (relayAuthFails.n >= 20 && Date.now() - relayAuthFails.at < 10 * 60_000) {   // :1812
  relayPublish({ rh: true, type: "rherr", reqId: shim._currentReqId, error: "too many failed auth attempts" });
  return;
}
```

Line 1812 is reachable only when `shim._authed` is already true, because every
unauthenticated message returns at line 1806. An attacker sending a bad token
therefore never reaches the gate at all: the shim is deleted, the counter is
incremented, and the next message from the same peer recreates a fresh shim via
`relayShimFor(from)` (`:1725`) with `_authed: false`, landing in the same
unauthenticated branch again. The counting happens; the enforcement cannot.

The gate does fire against a peer that has already authenticated successfully,
which is the exact inverse of its purpose. Because `relayAuthFails` is a single
counter shared across all relay peers and is never cleared on a successful
authentication (`:1808` sets `shim._authed = true` but does not touch the
counter), twenty bad attempts from any one source will start refusing service to
every honest authenticated peer until the ten-minute window rolls. The intended
defence is inert and the effect it does have is a cross-peer denial of service.

Practical exploitability is low, and the plan should not overstate it: the relay
token is generated as `crypto.randomBytes(24).toString("hex")` at
`daemon/src/config.js:23`, which is 192 bits, so the missing rate limit does not
open a realistic path to recovering the token. This is a correctness defect with
a denial-of-service side effect, not a token-recovery path.

There is a test gap alongside it. `daemon/test/relay-bridge.test.mjs` covers a
bad token being rejected (`:115-120`) and a good token receiving `welcome`
(`:122-126`), but it never drives twenty failures and never asserts the gate. The
202 passing checks in the suite do not exercise line 1812 at all, which is why
the inversion survived.

Fix: move the window check above the `if (!shim._authed)` branch so it is
evaluated for every inbound `rhreq`, clear `relayAuthFails` on successful
authentication, and add a test that drives 21 bad hellos and asserts the 21st is
refused while a good token still authenticates afterwards.

### 2. The absorption ledger's headline counts do not reconcile with its body — high

`docs/ABSORPTION-LEDGER.md:17` states:

> Counts: ✅ 99 · ⚙️ 74 · 🧩 0 · ➖ 68 · **total 241**.

A programmatic count of the status column across every per-repo table in the
same file yields 165 status rows: ✅ 71, ⚙️ 78, 🧩 0, ➖ 13, 🗺️ 3.

The two cannot both be right, and the direction of one difference proves the
header is the wrong one. Several rows collapse a group of related repositories
into a single row (for example `pty_basic_*` at `:129`, which represents 42
corpus directories), so the body legitimately has fewer rows than the corpus has
repositories — 165 rows for 241 repos. But collapsing only ever reduces the row
count relative to the per-repo total. The body's ⚙️ count (78) is *higher* than
the header's ⚙️ count (74), which no aggregation of collapsed groups can
produce. The header figures for at least ⚙️ and ➖ (68 claimed against 13 body
rows) are therefore wrong, and the `total 241` line is arithmetic over wrong
inputs rather than a verified sum.

This matters because the ledger is the project's record of what the corpus
contributed. A reader who trusts the header is reading numbers nothing in the
file supports.

Fix: recount the status column from the body, decide explicitly whether the
published figures are per-row or per-repo, state which, and make the two views
consistent. If the intent is per-repo, the collapsed groups need their membership
listed so the total can be checked.

### 3. "Each repo appears exactly once" is false — high

`docs/ABSORPTION-LEDGER.md:264`:

> Repo count: **241** directories in the corpus, **241** rows above (each repo
> appears exactly once; cross-references marked "listed §" are navigational, not
> double-counted).

Three separate contradictions:

- `tailscale` appears twice, as two identical rows, at `:159` and `:160`.
- A third reference to it appears at `:179` as
  `| tailscale … (already listed) | — | — |`, which uses `—` in the status column
  and so is neither a status row nor one of the "listed §" cross-references the
  verification note excuses.
- The `pty_basic_*` row at `:129` collapses 42 corpus directories into one row,
  which is the direct opposite of one row per repo.

The claim "241 rows above" is also not what the file contains; there are 165
status rows. Fix: remove the duplicate row, replace the `—` cross-reference with
either a real entry or a form the verification note actually describes, and
rewrite the verification sentence so it says what the file does — rows are
per-group for the tutorial-clone batch, and the per-repo total is derived from
group membership.

Related: the corpus directory count of 241 (`:3`) is correct. The corpus folder
holds 247 entries, but six are files rather than repositories — `MANIFEST.md` and
five `done-*.log` files — so 241 directories is right and this figure needs no
change.

### 4. The `🗺️` mark is used throughout but defined nowhere — medium

The legend at `docs/ABSORPTION-LEDGER.md:12-16` defines four marks: ✅, ⚙️, 🧩,
and ➖. The `🗺️` mark appears in the body at `:75`, `:84`, `:88`, `:107`,
`:117`, `:118`, `:143`, `:144`, `:146`, and `:148`, and the verification section
at `:264-268` refers to "the 🗺️ list" as though it were defined. Fix: add a
legend row for 🗺️ — its meaning is clear from use (a named feature deliberately
deferred, e.g. mosh-style UDP roaming, asciicast player, E2EE shares) but it is
not stated.

### 5. The feature matrix advertises the wrong corpus size — medium

`docs/FEATURE-MATRIX.md:3` says "the 220-repo inspiration corpus". The corpus is
241 repositories, per the ledger at `:3` and per a direct count of the corpus
directory. The two documents disagree about the size of the same corpus. Fix:
correct to 241, or note explicitly if 220 refers to a distinct subset (no such
subset is defined anywhere in either document).

### 6. The tutorial-clone row contradicts itself on its own count — medium

`docs/ABSORPTION-LEDGER.md:129` reads "pty_basic_* (42 tutorial clones: …)" and
then, in the same cell, "reproduced ~45×". The corpus contains exactly 42
`pty_basic_` directories, so 42 is the correct figure and "~45×" is wrong. The
row also lists 30 names followed by an ellipsis, so a reader cannot verify the
42 from the file. Fix: state 42 once and either list all 42 or state plainly
that the list is partial.

### 7. Relay responses are correlated with the wrong request — medium

`daemon/src/server.js:1745` — the shim's `send()` publishes every outbound
message as `{ rh: true, type: "rhresp", reqId: s._currentReqId, data }`, and
`_currentReqId` is a single mutable field on the shim, overwritten by every
inbound message at `:1793` (`shim._currentReqId = data.reqId ?? null`).

A shim can be attached to a session and to a chat (the eviction path at
`:1747-1757` calls `sessions.detach(dead)` and `chat.detach(dead)`, which only
makes sense if shims are attached in the first place). Output streamed from an
attached session or chat is delivered through `shim.send`, so each line is
tagged with whatever request id arrived most recently rather than the id of the
request it answers. Two consequences: if a peer issues request A and then
request B before A's handler replies, A's reply carries B's id; and unsolicited
stream output carries the id of the last request, so a client correlating on
`reqId` will mis-attribute streaming output as the response to its most recent
request.

Fix: carry the request id in the request's own context rather than on the shim,
and send `reqId: null` for output that answers no request. This is a
client-visible protocol correctness issue, not a security one.

### 8. Shim eviction is first-in-first-out, not least-recently-used — low

`daemon/src/server.js:1747-1757`. When the shim map reaches `RELAY_SHIM_MAX`
(64), the eviction takes `relayShims.keys().next().value` — the oldest *inserted*
entry, since `Map` preserves insertion order. `relayShimFor` returns an existing
shim without re-inserting it (`:1726-1728`), so an active, recently-used peer
keeps its original insertion position and is evicted in preference to a shim that
has been idle since it was created. The comment at `:1744-1746` describes the
intent accurately ("a peer that auths then silently dies leaves its shim
behind"), but the implementation cannot distinguish that case from the busy peer.
Fix: on a cache hit, delete and re-set the key so `keys().next()` is genuinely
the least recently used, or track a last-used timestamp.

### 9. The Android app has no tests at all — medium

`app/` contains no `test/` or `androidTest/` directory. All 19 Kotlin files are
untested, including the files that hold logic where a test would be cheap and a
mistake costly: `ReconnectPolicy.kt` (backoff decisions), `Tls.kt` (certificate
handling), `TunnelManager.kt`, `SessionRecorder.kt`, and `SessionExporter.kt`.

The daemon side of this project has 41 test files and 202 passing checks; the
phone app has none. That asymmetry means every Kotlin change is verified only by
whether it compiles. Fix: add a JVM unit test source set and start with the pure
functions — `ReconnectPolicy` is the clearest first target because its behaviour
is entirely decidable from its inputs and needs no Android framework.

### 10. The tmux availability probe is duplicated three times — low

`daemon/src/server.js:1129`, `:1135`, and `:1164` each run the identical probe:

```js
try { _execSync("tmux -V", { encoding: "utf-8", timeout: 3000, stdio: "pipe" }); available = true; } catch {}
```

Three identical three-second-timeout subprocess spawns, each with its own
`available` variable. Fix: one memoised helper, since the answer cannot change
within a process lifetime in a way that matters.

### 11. The relay framer discards bytes it failed to parse, and has no size cap — medium

`daemon/src/relay_server.js:52-59`, found while writing the test for defect 1.

The relay's wire protocol is newline-terminated: the daemon's own link writes
`JSON.stringify(obj) + "\n"` (`daemon/src/relay.js:171`) and the relay writes
`JSON.stringify(message) + "\n"` back (`relay_server.js:89`, `:98`). The read path
splits on newlines, and then adds a tolerant fallback for a client that writes one
JSON frame with no trailing newline:

```js
if (conn.buf.trim()) {
  try {
    this.handleMessage(connId, conn.buf.trim());
    conn.buf = '';                       // cleared whether or not it parsed
  } catch {}
}
```

`handleMessage` swallows its own parse errors (`:62-72`), so the `catch` here is
dead and `conn.buf = ''` runs unconditionally. Two consequences.

A frame split across TCP segments by a client that omits the newline is *lost*:
the first segment fails to parse as JSON, `handleMessage` swallows the failure,
and the buffer is cleared, so the completing bytes arrive against an empty buffer
and are dropped in turn. The comment at `:36-37` claims split frames are handled,
which is true on the newline path and false on this one.

The buffer also has no upper bound. A peer that opens a connection and writes
bytes without ever completing a frame or a newline grows `conn.buf` for as long as
it keeps writing, with nothing to stop it.

Neither is reachable from the daemon's own link, which frames correctly, so the
practical exposure is limited to non-newline clients — the fallback exists at all
only for them. It remains a correctness and memory-safety defect in a component
that accepts unauthenticated TCP connections.

Fix: only clear the buffer when the frame actually parsed, keep incomplete bytes
buffered, and cap the retained buffer so a peer that never completes a frame is
disconnected instead of growing it forever.

### 12. Command analytics discard every tie, and the whole exporter is unwired — medium

`app/app/src/main/java/com/yasha/pocketdesk/SessionExporter.kt:145`, found by
the first tests written for the file.

`extractCommandStats` counted commands by first token and then ranked them:

```kotlin
return stats.toSortedMap(compareByDescending { stats[it] ?: 0 })
```

`toSortedMap` with a comparator builds a `TreeMap`, and this comparator orders
solely on the use count. Two programs used the same number of times therefore
compare equal, which a `TreeMap` resolves by keeping one key and dropping the
other. The result is silent data loss in exactly the case analytics exists to
report: given `git status`, `git log`, `cd /tmp`, `cd /var`, `ls`, the map comes
back as `{git=2, ls=1}` — `cd` is gone. With one command each, three programs
collapse to one.

This is latent rather than live, because nothing calls the function, or anything
else in `SessionExporter`: a search of `app/app/src` finds the file itself and no
other reference, so the replay-script, Markdown-report, cross-session search, and
command-statistics surfaces are all unreachable from the app. The test written for
this defect is the first code to exercise the file at all.

Fix applied: rank by count, then break ties on the program name, so no key is ever
treated as a duplicate of another. The unwired state is not fixed here — wiring
these exports into a screen is a product decision, and the file is written in
terms of `TerminalSession`, which the app already builds, so it is cheap to adopt
when that decision is made.

---

## Part 2 — Corpus coverage

The corpus is `C:\Users\yasha\PROJECTS\inspiration\PocketDesk`, 241
repositories. Its disposition is already recorded in
`docs/ABSORPTION-LEDGER.md` (per-repo, with the feature taken from each) and
`docs/FEATURE-MATRIX.md` (feature-by-feature, mapped to what ships). This
document does not duplicate 241 rows; it records that the absorption is complete
and that the two documents describing it need the corrections in Part 1.

Status of the corpus as audited:

- 241 repositories, all processed individually, none still carrying the
  `done_<repo>` prefix (the naming convention is described in the ledger header:
  a directory is renamed `done_<repo>` once cleared, and the recheck pass renamed
  every one of them back).
- `🧩` (module present but unwired) count is 0. The ledger's claim at `:265` that
  the previously unwired module surface — VNC, SSH bastion, advanced SSH,
  multi-protocol client — is now wired is consistent with the module set present
  under `daemon/src/`.
- Remaining work is the `🗺️` list only. Per `:266-267`: mosh-style UDP roaming,
  E2EE shares, ZMODEM, biometric app lock, asciicast player, foreground service,
  worktree isolation, device revocation, mkcert CA, and TOTP/OIDC.
- The 42 `pty_basic_*` tutorial clones are genuinely 42 directories and were
  correctly judged as one template reproduced many times; the defects in Part 1
  items 3 and 6 concern how that fact is written down, not the judgement itself.

The documentation-integrity defects in Part 1 items 2, 3, 4, 5, and 6 do not
undermine the absorption work. They mean the record of that work cannot currently
be audited or trusted from the numbers it publishes, which — for a document whose
entire purpose is to be the auditable record — is a real defect.

---

## Part 3 — Plan

Phases are ordered so that the correctness fix lands first and the documentation
is corrected before further work builds on it.

**Phase 0 — Fix the inverted relay gate.** Move the `relayAuthFails` window check
above the `if (!shim._authed)` branch in `daemon/src/server.js` so it runs for
every inbound `rhreq`; clear the counter on successful authentication; confirm
that a legitimate peer is no longer locked out by another peer's failures. Add
the missing test to `daemon/test/relay-bridge.test.mjs`: 21 bad hellos must be
refused on the 21st, and a good token must still authenticate immediately
afterwards. This closes the one genuine logic defect in the daemon.

**Phase 1 — Reconcile the documentation.** Recount the ledger's status column and
make the header, body, and verification section agree (items 2 and 3). Delete the
duplicate `tailscale` row and the `—` cross-reference, or convert them to a form
the verification note describes. Add the `🗺️` legend row (item 4). Correct
`FEATURE-MATRIX.md:3` from 220 to 241 (item 5). Resolve the 42-versus-45
contradiction in the `pty_basic_*` row (item 6). Nothing in this phase changes
behaviour, and it should land before any further absorption work so later changes
are recorded against accurate baselines.

**Phase 2 — Relay protocol correctness.** Carry the request id per request rather
than on the shim, and send `reqId: null` for unsolicited output (item 7). Make
shim eviction genuinely least-recently-used (item 8). Both are small changes to
the same region of `daemon/src/server.js` and should be done together with tests
in the existing relay test files.

**Phase 3 — Start testing the Android app.** Add a JVM unit test source set.
Write `ReconnectPolicy` tests first, then `SessionRecorder` and
`SessionExporter` (serialisation round-trips), then `Book`/`ServerBook` parsing.
Leave `TunnelManager` and `Tls` for last, since they need more scaffolding
(item 9). Wire the new source set into whatever the project already uses to build
so the tests actually run rather than sitting unexecuted.

**Phase 4 — Small cleanups.** Replace the three duplicated tmux probes with one
memoised helper (item 10).

**Phase 5 — The residual roadmap.** Work the `🗺️` list from the ledger, in the
order the coverage documents argue for. The two items that most change what the
product is are device revocation (`devices.js` already exists; the ledger records
that the UI-side revocation is what is missing) and E2EE for shares. mosh-style
UDP roaming is largely subsumed by Tailscale per the ledger's own note at `:143`,
so it should be the lowest priority of the set rather than the highest-sounding
one.

---

## Part 4 — Not doing

- **Re-auditing the corpus.** The absorption is complete and the `🧩` count is 0.
  Re-processing 241 repositories to second-guess decisions already recorded would
  cost a great deal and change little. The documentation defects are fixed in
  Phase 1 instead.
- **Reporting the shell-execution sites as vulnerabilities.** Verified and
  rejected — see the note at the top of Part 1. Listing them would be a
  restatement of the feature that makes this project useful.
- **Removing the empty `catch {}` blocks.** They are correct for best-effort
  cleanup and optional parses. Removing them would add noise and change
  behaviour for the worse.
- **Introducing a test framework for the Kotlin side.** Phase 3 uses the JVM test
  source set the Android build already supports and adds JUnit 4, which is the
  assertion library the Android Gradle plugin's unit-test task expects. No runner,
  mock framework, or Robolectric was added: the classes worth testing first are
  pure functions.
- **Touching the keystore or signing configuration.** Keystores are correctly
  ignored and untracked. Nothing about them is in scope.

---

## Part 5 — Verification

| # | Defect | How it is confirmed | How the fix is checked |
|---|---|---|---|
| 1 | Relay gate inverted; peer lockout | `server.js:1806` returns before `:1812` can be reached; `relayShimFor(:1725)` recreates an unauthenticated shim on the next message | New test: 21st bad hello refused; good token still authenticates afterwards; suite still passes |
| 2 | Ledger counts do not reconcile | Body status rows counted programmatically: 165 rows (✅71 ⚙️78 🧩0 ➖13 🗺️3) against header ✅99 ⚙️74 🧩0 ➖68 = 241; body ⚙️ > header ⚙️ rules out a collapsed-group explanation | Recount script: header figures equal the body's, with the per-row/per-repo basis stated in the file |
| 3 | "Each repo appears exactly once" false | `tailscale` at `:159` and `:160`, cross-reference at `:179`; `pty_basic_*` collapses 42 directories at `:129`; 165 status rows not 241 | Deduplicated; verification sentence matches what the file contains |
| 4 | `🗺️` undefined | Used at `:75`, `:84`, `:88`, `:107`, `:117`, `:118`, `:143`, `:144`, `:146`, `:148`; legend at `:12-16` defines ✅⚙️🧩➖ only | Legend lists every mark the body uses |
| 5 | Wrong corpus size | `FEATURE-MATRIX.md:3` says 220; corpus holds 241 repositories per ledger `:3` and direct count | Both documents state 241 |
| 6 | 42 vs ~45 | Corpus contains exactly 42 `pty_basic_` directories; row at `:129` says both 42 and "~45×" | One figure, consistent with the directory count |
| 7 | Wrong request correlation | `send()` uses shim-level `_currentReqId` (`:1745`), overwritten per inbound message (`:1793`) | Test: two concurrent requests get their own ids; unsolicited output carries `null` |
| 8 | FIFO eviction | `relayShimFor(:1726-1728)` returns without re-inserting, so `keys().next()` is first-created | Test: filling past `RELAY_SHIM_MAX` evicts the idle shim, not the active one |
| 9 | No Kotlin tests | No `test/` or `androidTest/` anywhere under `app/`; 19 Kotlin files | Test source set exists and runs; `ReconnectPolicy` cases pass |
| 10 | Triplicated tmux probe | `server.js:1129`, `:1135`, `:1164` are byte-identical probes | One helper; grep finds a single `tmux -V` |
| 11 | Relay framer drops unparsed bytes; no size cap | `relay_server.js:52-59` clears `conn.buf` regardless of whether the frame parsed, and `handleMessage` (`:62-72`) swallows the error that the surrounding `catch` is waiting for | `relay.test.mjs`: a frame split across two writes is delivered; a peer that exceeds the cap without completing a frame is dropped and a well-behaved peer is unaffected |
| 12 | Command analytics drop every tie; exporter unwired | `SessionExporter.kt:145` builds a `TreeMap` ordered on the count alone, so tied keys compare equal and one is discarded; no file under `app/app/src` references `SessionExporter` | `SessionExporterTest`: tied programs all survive and the result is ordered by count then name; the unwired state is recorded, not silently wired |

---

## Part 6 — Applied fixes

Applied in this pass, with the check that confirms each one.

**1 — Relay brute-force gate.** `daemon/src/server.js`. The window check now runs
before the `if (!shim._authed)` branch, so it is evaluated for every inbound
`rhreq` instead of only for already-authenticated peers. The counter moved from a
single shared integer to a `Map` keyed by relay peer id, with the record dropped
once its window expires; a successful hello clears that peer's own count. A peer
that has spent its budget is refused even when it presents the correct token,
until the window rolls.

*Check:* `daemon/test/relay-bridge.test.mjs` gained case 7. One peer sends 21 bad
hellos, then the correct token; a second peer sends the correct token. Four new
assertions cover it. Removing the enforcement makes exactly the two lockout
assertions fail and leaves the other eleven passing, which is what makes the test
a check on the gate rather than a check on the harness.

**7 — Request correlation.** `daemon/src/server.js`. The shim no longer carries
`_currentReqId`. The id lives in an `AsyncLocalStorage` store entered around each
`handle()` call, and `send()` publishes `relayReqCtx.getStore() ?? null`, so a
response is tagged with the request it answers and stream output that answers no
request is tagged `null` instead of with whatever arrived most recently. The store
is per-request rather than per-shim because one shim serves concurrent requests.

**8 — Shim eviction.** `daemon/src/server.js`. `relayShimFor` deletes and re-sets
an existing key, so `Map` insertion order tracks recency and the eviction at
`RELAY_SHIM_MAX` drops the least recently used shim rather than the
first-created one.

**10 — tmux probe.** `daemon/src/server.js`. All three `_execSync("tmux -V")`
probes are replaced with `await tmux.isAvailable()`, the memoised
non-blocking helper the file already used elsewhere. `_execSync` remains for the
one caller that still needs it.

**11 — Relay framer.** `daemon/src/relay_server.js`. The fallback now parses to
decide whether the buffered bytes are a complete frame, keeps them when they are
not, and destroys the socket past `MAX_FRAME_BYTES` (1 MiB).

*Check:* `daemon/test/relay.test.mjs` gained two cases. A frame written in two
halves with no newline is delivered whole; a peer that writes past the cap without
ever completing a frame is dropped from the relay's connection registry, and a
second peer that frames correctly still receives messages afterwards. Each half of
the fix is pinned by one of them: restoring the old buffer-clearing loses the
split frame (the case times out), and disabling only the size cap leaves the
flooding peer connected. The assertion is taken from `RelayServer.connections`
rather than from the offending client's `close` event, because a peer destroyed
mid-write does not reliably observe that event on its own side.

**Also fixed in the test harness, not the product.** `relay-bridge.test.mjs`'s
relay client wrote frames with no trailing newline and relied on the tolerance
fallback, and it declared its peer with `const` inside the `try` block while
`finally` closed a different, always-null binding. Both are corrected: the client
frames on newlines and reads by line, and the peer is assigned to the outer
binding that `finally` closes. The first of these is what exposed defect 11.

**2, 3, 4, 5, 6 — Documentation.** `docs/ABSORPTION-LEDGER.md` and
`docs/FEATURE-MATRIX.md`. The ledger header now reports the counts the body
actually contains (✅71 · ⚙️77 · 🧩0 · ➖13 · 🗺️3, plus 2 cross-references = 166
rows) and states that rows and repositories are different units and why. The
duplicate `tailscale` row and the redundant self-cross-reference are gone, the
`🗺️` mark has a legend entry, the `pty_basic_*` row names all 42 members and says
42 once, and the matrix's corpus size and clone count are corrected to 241 and 42.
The verification section's "241 rows above, each repo appears exactly once" is
replaced with what the file holds: 166 rows, 226 distinct labels, 241 corpus
directories counted directly, and the five labels that appear twice named
individually.

*Check:* the counts above are produced by a script that reads the status column
out of the ledger, not by hand.

**9 — Android tests.** `app/app/build.gradle.kts` gains
`testImplementation("junit:junit:4.13.2")` and the module's first JVM test source
set holds two files, 14 tests.

`ReconnectPolicyTest` (6) covers the backoff ladder: attempt budget, exponential
growth against the cap, jitter bounds at both the floor and the ceiling, and
`reset()`. Every assertion is a range assertion, since the jitter is random by
design.

`SessionExporterTest` (8) covers the replay shell script (header, commands only,
`sleep` lines only for gaps over a second, and switchable off), the Markdown
report (bookmark list, 500-character output truncation), case-insensitive
cross-session search, command statistics, and the conversion of a recorded
session's events into entries with timestamps offset by the session start. The
command-statistics cases are what found defect 12.

*Check:* `./gradlew :app:testDebugUnitTest` reports 14 tests, 0 failures, 0 errors.
Changing the attempt budget in `ReconnectPolicy` from `attempt >= maxAttempts` to
`attempt > maxAttempts` makes two of the six ladder tests fail, and restoring the
count-only comparator in `extractCommandStats` makes both statistics assertions
fail, so the suite reads the behaviour rather than merely running.

**12 — Command analytics.** `SessionExporter.extractCommandStats` now ranks by
count and breaks ties on the program name, so a `TreeMap` cannot treat two
tied programs as one key. `SessionExporter` remains unwired; adopting it is a
product decision recorded in Part 1 item 12.

**Still open.** Testing `SessionRecorder` (it writes files, so it needs either a
temporary directory or the recorder's format methods split out) and `ServerBook`
(needs `SharedPreferences`, so Robolectric or an instrumented test — deliberately
left for last, as Phase 3 says). Neither was attempted here. Phase 5's roadmap
list, and the decision about whether the deferred `🗺️` features are built, also
remain open.
