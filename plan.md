# plan.md — PocketDesk

Consolidated engineering plan. Absorbs `docs/roadmap-design.md` (its Part 4
status shows 2.1/2.2/2.3 done; only the hardware checks remain, carried to
Appendix A), `docs/INTEGRITY.md` (plan; its Phase 0 becomes M1.1 here, its
Phases 1–4 become M1.2/M6.1/M6.2, its open questions go to Appendix A), and the
plan-like parts of `CONTEXT.md` (dated 2026-09-22 and already wrong about the
tree — see M1.4).

Generated 2026-11-24. Evidence base: `README.md`, `CONTEXT.md`,
`CONTRIBUTING.md`, `NOTICE`, `daemon/package.json`, `daemon/src/*` (16,373
lines, 247 `.js`/`.mjs` files), 50 daemon test files, `app/gradle/libs.versions.toml`,
73 Kotlin files with 72 `@Test`, `daemon/public/ui/*.js`, `.github/workflows/ci.yml`,
and every doc under `docs/`.

**Order:** corrective → preventive → perfective → widening → depth → enterprise.

**Hierarchy:** Phase → Major (M#.#) → Minor (m#.#.#) → Subtask. One subtask = one

**Done tasks stay.** A finished subtask becomes `- [x]` in place with one evidence line under it (`verified-here: <command> → <result>`). Nothing is ever removed from this list.
PR = one command that proves it.

**Tag (exactly one):** `[C]` corrective · `[P]` preventive · `[F]` perfective ·
`[W]` widening · `[D]` depth · `[E]` enterprise.

**Method anchors:** `security-operations` §5 (threat model, closeable tooling),
`mobile-apps` §4/§5, `backend-api` §7/§9 (protocol contract, failure paths),
`engineering-craft` (behaviour is the contract), `devops-cloud` §8/§9,
`design-ux` §1/§5, `writing-docs` §1.

---

## 0. Verified ground truth

| Fact | Measured | Claimed | Source |
|---|---|---|---|
| Daemon runtime | Node `>=24`, `type: module`, `node --test` | "Node ≥24" | `daemon/package.json` |
| Daemon code | **153** `.js`/`.mjs` files outside `node_modules` (150 of them in `daemon/`: 95 `.js` + 55 `.mjs`); `daemon/src` is 16,373 lines | earlier draft said 247 — wrong | `find daemon -name '*.js' -o -name '*.mjs' \| grep -v node_modules \| wc -l` → 150; repo-wide → 153 |
| Largest daemon files | `desktop_capture.js` 1,905, `server.js` 956, `public/vendor/qrcode.min.js` 2,298 (vendored, not ours) | — | `find … -exec wc -l {} + \| sort -rn` |
| Daemon deps | `node-pty 1.2.0-beta.15`, `ssh2 ^1.17`, `ws ^8.22`, optional `@number0/iroh ^1.1` | — | `daemon/package.json` |
| Daemon tests | 50 files (`*.test.mjs`) | badge says "28 suites" | `ls daemon/test` |
| Android | AGP `9.5.0-alpha09`, Kotlin `2.5.0-Beta1`, `compileSdk 37.2`, `targetSdk 37`, JDK 25 | — | `app/gradle/libs.versions.toml` |
| Android code | 73 Kotlin files, 72 `@Test` cases | — | `find` + `grep` |
| Android instrumented | none in CI (lint + `testDebugUnitTest` + `assembleDebug` only) | — | `ci.yml` |
| Native | Rust helpers (`native/`, 287 KB), `cargo test --release` in CI | webcam + controller | `ci.yml:112-134` |
| Web client | `daemon/public/index.html` (53 lines) + `ui/{core,hub,pages,thispc,computers,phone,share,extras}.js`, 250 KB total | "the hub" | `ls daemon/public` |
| Plugin system | `src/plugins.js` + `src/plugins/metrics-plugin.js`, 4 documented plugins | "Plugins 4" | `daemon/src`, README |
| Transport | `wss` only on LAN, iroh QUIC off-LAN, H.264/AV1/HEVC video | same | absorbed roadmap (done), `docs/RELAY.md` |
| Licence | GPL-3.0-or-later, `NOTICE` present, SPDX headers required | — | `LICENSE`, `NOTICE` |
| CI jobs | 3: daemon matrix, Android lint/unit/build, Windows native helpers | — | `.github/workflows/ci.yml` |
| Integrity posture | stealth install, elevation, silent restart still default | `docs/INTEGRITY.md` says plan only | `docs/INTEGRITY.md` |
| `CONTEXT.md` accuracy | says `test/smoke.mjs` only, `public/index.html` is the hub, Kotlin 2.5.0-Beta1, no mention of 50 test files | stale | `CONTEXT.md` vs tree |

Invariants:

1. **Plaintext never leaves the machine.** `ws://` is loopback-only; the phone refuses a non-`wss` URL; the manifest allows no cleartext.
2. **Settings that change security posture are changed at the PC browser** (loopback + key), never from the phone: devices, revocation, TOTP, control toggle.
3. **Tokens stay on the PC.** Account switching never ships a credential to the phone; masked values are restored on save.
4. **No anti-detection work, ever.** No hooking, no driver, no enumeration hiding, no anti-forensics (contribution rule from `docs/INTEGRITY.md` P4).
5. **No feature whose purpose is to defeat a proctoring or remote-management client.** Policy and visibility are the controls; evasion is out of scope permanently.
6. **Protocol messages are a contract**: `protocol-contract.test.mjs` defines them; a new message needs a test and a doc line.

---

## Phase 1 — Corrective: the tool must be visible and closeable

### M1.1 Say what it is (docs only, unblocked)

**Why:** the README still sells stealth ("visible only in Task Manager") and
AMSI-adjacent framing, while `docs/INTEGRITY.md` establishes that this is what
makes remote-control abuse deniable and effortless. The words create the risk.
**Done when:** no doc claims invisibility, and the responsible-use limit is on
the front page.

- [x] New README section "Responsible use": not for proctored assessments, not for another person's machine or session, and the two-line reason. `[C]`
  verified-here: `grep -A8 '^### Responsible use' README.md` → section at line 688 names proctored assessment/interview/exam and driving another person's session, with the reason
- [ ] Remove every "invisible to antivirus / anti-cheat" and AMSI claim from `README.md`, `CONTEXT.md`, `EXCLUSIVE-FULLSCREEN.md` and the `desktop_capture.js` header comment. `[C]`
- [ ] Add the `CONTRIBUTING.md` rule (no anti-detection, no anti-forensics, no driver, no enumeration hiding) and a grep-able list of banned patterns. `[C]`
- [ ] Link `docs/INTEGRITY.md` from README and CONTRIBUTING; keep it as the standing statement. `[C]`

### M1.2 Be closeable

**Why:** `install.ps1` re-runs `install-service.ps1 -Protect` under UAC and
registers `-RunLevel Highest` with `RestartCount 3`; an elevated, self-restarting
daemon is the one control a native integrity client cannot beat.
**Done when:** the default install can be stopped by the machine owner and stays
stopped.

- [ ] Default install runs unelevated (`RunLevel Limited`, per-user task, data under `%LOCALAPPDATA%`); `-Protected`/`--elevate` becomes an explicit advanced flag with a warning that it is uncloseable by ordinary apps. `[C]`
- [ ] Remove `RestartCount` from the default task; a stop is a stop, and the next start is a user action. `[C]`
- [ ] `pocketdesk stop` terminates the PowerShell, ffmpeg and helper children, and asserts nothing re-arms capture or input. `[C]`
- [ ] Test in `daemon/test`: a simulated lockdown client enumerates processes, reads the scheduled task, kills every PocketDesk process, then asserts nothing is left and nothing returns. The same test against the current build must fail — that is the regression oracle. `[C]`
- [ ] `pocketdesk --status` prints elevated (yes/no), auto-start, restart policy, ports and data folder, one line each. `[C]`

### M1.3 Visibility

- [ ] Tray icon with Stop / Open settings / Uninstall, and a one-time "PocketDesk is running" notice at logon. `[C]`
- [ ] Write start, stop and policy events to the Windows Event Log under source `PocketDesk`, so an external client can read them without guessing. `[C]`
- [ ] Uninstall removes task, Start Menu entry, firewall rule, `ProgramData` policy and data folder only on confirmation; assert with a test on the installer scripts. `[C]`

### M1.4 Stop the release path shipping alphas

**Why:** the APK users install is built by AGP `9.5.0-alpha09` and Kotlin
`2.5.0-Beta1`; the daemon's PTY layer is `node-pty 1.2.0-beta.15`. Toolchain
pre-releases change R8 and native ABI behaviour between builds of one commit.
**Done when:** release builds use stable versions and a second build of the same
commit is byte-identical.

- [ ] Pin AGP, Kotlin and Compose to the newest **stable** line that supports `compileSdk 37.2`; record the blocker in a comment if one remains. `[C]`
- [ ] Pin `node-pty` to a stable release, or vendor the beta with an ADR stating the risk and the exit condition. `[C]`
- [ ] Add a check that fails the build when `libs.versions.toml` or `package.json` gains a pre-release version without a `# prerelease:` note. `[P]`
- [ ] Reproducible APK: build the same commit twice with the same keystore, compare `sha256sum`, document any non-deterministic input. `[C]`

### M1.5 Make the stale docs true

- [ ] Rewrite `CONTEXT.md` from the tree (paths, test entrypoints, plugin location, Android versions) or delete it; a doc that names the wrong files costs more than it saves. `[C]`
- [ ] Fix the "28 suites" badge to the generated test-file count. `[C]`
- [ ] `docs/FEATURE-MATRIX.md` and the README feature table re-checked against `handlers/*` message names; a feature with no handler is removed. `[C]`
- [ ] `daemon/README`-level statement of every protocol message with its handler file, generated from the registry. `[C]`
- [ ] Fold the console-pairing checks into existing suites rather than new files: a pair payload carrying `n` when `RH_LABEL` is set and omitting it otherwise (extend a pairing/protocol test), and a byte-identity test that `DesktopController` output is identical with and without `RH_CONSOLE` (driven through a `node -e` subprocess, because `IS_CONSOLE` is read at module load). `[C]`
- [ ] Write the `docs/SETUP-PC.md` "Console access (lock screen / UAC / before login)" section and add the console module, ports 8765/8766 and `RH_CONSOLE`/`RH_LABEL`/`RH_HOME` to `CONTEXT.md`. `[C]`

### M1.6 Android has never run a test on a device in CI

- [ ] Emulator CI job (`reactivecircus/android-emulator-runner`, API 26 and 37): `connectedDebugAndroidTest`; start with the pairing and TLS tests. `[C]`
- [ ] Robolectric (or Roborazzi) tests for the five main screens so layout can be checked without hardware. `[C]`
- [ ] Instrumented test for `LinkService` foreground start, background survival and stop. `[C]`
- [ ] Instrumented test for `AppLock` re-lock after 30 s background. `[C]`
- [ ] Instrumented test that a `ws://` QR payload is rejected with the documented message. `[C]`

---

## Phase 2 — Preventive

### M2.1 Daemon test depth

- [ ] Coverage via `c8` with a floor per `src/` area; ratchet up only. `[P]`
- [ ] `protocol-contract.test.mjs` is the contract: assert every message in the registry has a handler, a doc line and a round-trip test; unknown type returns the documented error. `[P]`
- [ ] Failure injection: kill a PTY child mid-stream, drop the socket mid-transfer, corrupt a chunked `fread`; each asserts a user-visible error and no orphaned process. `[P]`
- [ ] Leak guards: `sessions-leakguard` exists; extend it to 100 create/kill cycles and to the phone-adb and desktop-video paths, asserting handle and memory stability. `[P]`
- [ ] Filesystem safety: every `fs_op` path resolved and confined; tests for `..`, symlinks, `\?\` prefixes, and Windows reserved names. `[P]`
- [ ] Windows-only code paths (`ConPTY`, `SendInput`, `Task Scheduler`) get a CI job on `windows-latest`; they are the least covered and most used. `[P]`

### M2.2 Lint and format for JavaScript

- [ ] The daemon has no linter; add ESLint (flat config) + Prettier, blocking, with `node --check` kept as the cheap first gate. `[P]`
- [ ] Add `--experimental-strip-types`-free JSDoc types and `tsc --checkJs --noEmit` on `src/` with a per-file allowlist that shrinks. `[P]`
- [ ] Ban `child_process.exec` with interpolated strings; allow only `execFile`/spawn with an argv array. `[P]`
- [ ] Assert no `shell: true` outside `scripts/`. `[P]`

### M2.3 Supply chain and release

- [ ] `npm audit` and `cargo audit` in CI; Gradle dependency verification (checksums) on. `[P]`
- [ ] SBOM for the daemon (`cyclonedx`) and the APK; attach to the release. `[P]`
- [ ] `SHA256SUMS` and a signed tag per release; the release workflow asserts the tag matches `package.json` and `versionName`. `[P]`
- [ ] GPL compliance check: every released artefact has a source offer and the corresponding source tag. `[P]`
- [ ] Secret scan (`gitleaks`) plus a test that `keystore.properties`, `*.keystore`, `pocketdesk.ini` never appear in `git ls-files`. `[P]`

### M2.4 Browser client tests

- [ ] No test covers `daemon/public/ui/*.js`; add Playwright against a fake daemon: pairing page, device table, TOTP section, one terminal session. `[P]`
- [ ] Accessibility smoke: axe on the settings and hub pages, zero critical findings. `[P]`
- [ ] Assert the loopback/Host/key guard on `/pair` and every `/access/*` route: 403 without the key, 403 from a non-loopback Host. `[P]`

### M2.5 Upgrade and compatibility

- [ ] Protocol version in the hello message plus a mismatch message on both ends, tested. `[P]`
- [ ] Doc + test: adding a message is additive; changing one needs a version bump and a compatibility note. `[P]`
- [ ] Android `versionCode` monotonic check in CI and a changelog entry per release. `[P]`

---

## Phase 3 — Perfective

### M3.1 Current runtimes and dependencies

**Why:** the Node floor, `node-pty` beta and `@number0/iroh` pin the daemon to a
version set that will age badly, and the Android app is on a Kotlin beta.
**Done when:** every runtime is on a current stable release and the suites pass.

- **m3.1.1 Daemon**
  - [ ] Node floor to the current LTS in `engines` and CI matrix; drop older runners. `[F]`
  - [ ] `node-pty` and `@number0/iroh` to current; re-run the terminal and remote-link suites. `[F]`
- **m3.1.2 Android build**
  - [ ] Gradle: configuration cache + isolated projects, JDK 25 pinned, build-time report; target a 30% faster CI job. `[F]`

### M3.2 Split the two monoliths

**Why:** `desktop_capture.js` (1,905 lines) and `server.js` (956) are the two files
most changes touch, and neither has a module boundary.
**Done when:** each is four modules with the existing tests as the net.

- **m3.2.1 Capture**
  - [ ] Split `desktop_capture.js` into capture, encode, input and topology modules with the existing tests as the safety net. `[F]`
- **m3.2.2 Server and web hub**
  - [ ] Split `server.js` into transport, routing and static-serving; keep one entrypoint. `[F]`
  - [ ] Consolidate the eight `daemon/public/ui/*.js` files behind one module boundary with explicit exports; remove globals. `[F]`

### M3.3 Measured performance and true docs

**Why:** "fast" is asserted; cold start and first frame are not measured, and two
transport docs describe a design that has moved.
**Done when:** both numbers are printed by CI and both docs are regenerated.

- **m3.3.1 Numbers**
  - [ ] Daemon cold start measured and budgeted (<400 ms on a mid PC); print the number in CI. `[F]`
  - [ ] Baseline Profile + Macrobenchmark for the Android app's first frame and chat scroll. `[F]`
- **m3.3.2 Docs**
  - [ ] Regenerate `docs/CONNECTIVITY-NOTES.md` and `docs/RELAY.md` from the current transport code; delete claims that no longer hold. `[F]`

---

## Phase 4 — Widening

### M4.1 Phone app

- [ ] Tablet and foldable layouts for the session list, terminal and desktop viewers. `[W]`
- [ ] Notification actions on session end: open, reply, dismiss, all without opening the app. `[W]`
- [ ] Session search and filter across agents, projects and dates. `[W]`
- [ ] Share a file into PocketDesk from any app (share target) and route it to the active session or a chosen folder. `[W]`
- [ ] Per-PC quick actions on the home screen (new chat, new terminal, files, desktop) as an editable grid. `[W]`

### M4.2 Daemon and agents

- [ ] Plugin SDK: documented lifecycle, a typed context, a test harness, and one example plugin that is not metrics. `[W]`
- [ ] Agent manifest registry: add a manifest by dropping JSON, with a validation command and a compatibility probe (`--version` parse) per agent. `[W]`
- [ ] Stream adapter versioning: a per-agent fixture set captured from the installed CLI version; a mismatch warns instead of silently mis-parsing. `[W]`
- [ ] Session recording: opt-in, local-only, replayable in the phone (as text, not video), with a retention cap. `[W]`
- [ ] Git panel: stage, commit, branch, diff view with the same proposal/approval gate as agent actions. `[W]`
- [ ] `pocketdesk doctor --json` for scripting: every probe, its result and the fix. `[W]`

### M4.3 Web hub

- [ ] Settings page: an audit view of pairing, device, policy and TOTP events with timestamps. `[W]`
- [ ] Device table: last seen, address, transport, and a per-device note. `[W]`
- [ ] A "what is running" page: daemon version, ports, active sessions, active streams, policy state. `[W]`
- [ ] One-click diagnostic bundle (logs + status + versions, no secrets) for support. `[W]`
- [ ] PWA install for the hub with an offline shell for read-only pages. `[W]`

### M4.4 Transport and reach

- [ ] Self-hosted iroh relay recipe and a documented fallback when the relay is unreachable. `[W]`
- [ ] Bandwidth cap per stream and a data-used counter per session, visible in the phone. `[W]`
- [ ] Audio-only mode for desktop streaming when the link is poor. `[W]`
- [ ] Multi-monitor naming and ordering from the PC, persisted per machine. `[W]`
- [ ] KVM mesh: document and test three-PC edge crossing end to end on real hardware (design exists; verification needs machines). `[W]`

---

## Phase 5 — Depth

### M5.1 Transport quality

- [ ] `docs/TRANSPORT-BENCH.md` lacks a real-phone, mobile-data measurement; publish loss, latency and bitrate adaptation from one device on 4G and one on Wi-Fi. `[D]`
- [ ] Congestion control: unit-test the bitrate ladder against a simulated link (5% loss, 200 ms RTT, 1 Mbps) and assert bounded latency and no stall. `[D]`
- [ ] Codec negotiation: assert AV1 → HEVC → H.264 fallback order works when the phone reports no decoder, with a synthetic capability matrix test. `[D]`
- [ ] Frame pacing: measure dropped frames under load and publish the number per encoder. `[D]`

### M5.2 Security depth

- [ ] Threat model for the daemon and phone app: LAN attacker, stolen phone, revoked-but-cached token, malicious QR, iroh relay, local unprivileged user, paper: what each can do today and which control stops it. `[D]`
- [ ] Pairing budget: a wrong-token attempt counter with backoff, tested; today the token is long-lived and the QR is the only secret. `[D]`
- [ ] Token rotation on every pairing and on revoke, with a test that an old token is refused immediately (not after reconnect). `[D]`
- [ ] iroh identity binding: assert the pinned endpoint id is checked, not just the TLS cert. `[D]`
- [ ] TOTP: recovery path, clock-skew tolerance and a test for replay of a used code. `[D]`
- [ ] Dependency and native-helper integrity: verify `scrcpy-server` and `adb` downloads against a pinned hash before execution. `[D]`

### M5.3 Agent stream robustness

- [ ] Golden transcript set per agent (Claude Code, Codex, Gemini, Qwen, OpenCode, Copilot, Cline) captured from current versions; parse tests run on all of them. `[D]`
- [ ] Unknown-field tolerance: a new field in a stream must not break parsing; test with a synthetic augmented transcript. `[D]`
- [ ] Tool-call correlation: assert start/result pairing under interleaved and cancelled turns. `[D]`
- [ ] Approval path: every request type (command, file write, diff) has a test for deny, allow and allow-all-for-session. `[D]`
- [ ] Resume semantics: continuing a history conversation must not duplicate messages; test against a captured history file. `[D]`

### M5.4 Interface craft

Method: `design-ux` §1/§5 — screenshot each surface at 360/412/768 dp and the web
hub at 360/768/1440, measure, three candidate fixes per problem, score, implement,
re-shoot.

- [ ] Baseline screenshots of every phone screen and hub page into `docs/screenshots/before/`. `[D]`
- [ ] One token source for the Compose theme and one for `public/ui/app.css` (spacing, type, colour, radius, motion); lint bans raw values. `[D]`
- [ ] Every screen has loading, empty, error and disconnected states with a retry. `[D]`
- [ ] Connection state: one indicator, one place, consistent wording across terminal, chat, files and desktop. `[D]`
- [ ] TalkBack pass on every phone screen and axe pass on every hub page; contrast ≥ 4.5:1, 48 dp targets. `[D]`
- [ ] Terminal ergonomics: font size control, selection copy, and extra keys that stay reachable one-handed. `[D]`
- [ ] Reduce motion setting honoured by the hub's animations and the phone's transitions. `[D]`

---

## Phase 6 — Enterprise

### M6.1 Machine-owner policy (the only control that works)

- [ ] Policy store: `HKLM\SOFTWARE\PocketDesk\Policy` plus `C:\ProgramData\PocketDesk\policy.json`, keys `AllowRemoteControl`, `AllowWebcam`, `AllowPhoneControl`, `AllowClipboard`. `[E]`
- [ ] Enforce before any remote sense starts; refuse with a visible `disabled_by_policy` reason naming the key, and log the refusal. `[E]`
- [ ] `pocketdesk policy` to set, inspect and reset, admin-only, with a test per key. `[E]`
- [ ] Lab recipe in `docs/`: set policy, verify with `--status`, hand the machine to a candidate. `[E]`
- [ ] Marked remote senses: virtual webcam off by default, watermark with phone name and UTC clock; phone-control notification non-dismissible while attached. `[E]`
- [ ] Decide the console endpoint's fate (drop from public builds, or admin-only with an audit line per input event) — see Appendix A. `[E]`

### M6.2 Publication and third parties

- [ ] `docs/for-proctoring-vendors.md`: process names, task name, service keys, install path, ports, data folder, the capture marker, how to verify and how to block, plus a contact. `[E]`
- [ ] `ALPHA-CAPTURE.md` gets the "do not use in proctoring, exam or DRM windows" warning. `[E]`
- [ ] `SECURITY.md`: disclosure path, supported versions, response time. `[E]`

### M6.3 Operability

- [ ] `docs/RUNBOOK.md`: daemon will not start, phone cannot pair, stream black, PTY dead, task missing, policy refused, relay down — each with the first diagnostic command. `[E]`
- [ ] Logging: one structured format, one file location, rotation and a size cap; no token or path leakage in logs (test). `[E]`
- [ ] Health surface for the hub: version, uptime, active sessions, last error. `[E]`
- [ ] Support matrix (Windows 10/11, macOS 12+, Linux X11, Android 8+) enforced by CI where possible and stated where not. `[E]`

### M6.4 Delivery discipline

- [ ] Semver with a changelog per release; daemon, APK and native helpers versioned together. `[E]`
- [ ] `CONTRIBUTING.md`: pre-push gate, the no-evasion rule, the protocol-change rule, and the one-subtask-one-PR rule. `[E]`
- [ ] ADRs for protocol changes, transport changes and any new permission. `[E]`
- [ ] Dependency update cadence (monthly) with the test result recorded, and a rollback path per release. `[E]`

---

## 7. Execution model: waves, effort, exit gates

Effort: **S** ≤ 1 day, **M** 2–3 days, **L** 1–2 weeks.

| Wave | Days | Objective | Majors | Effort | Gate |
|---|---|---|---|---|---|
| **W0** | 3–4 | Say what it is, make it closeable, make installs visible, drop alphas | M1.1–M1.6 | S+M+M+M+S+M | `docs/INTEGRITY.md` describes shipped behaviour, not a plan; a quit path exists and is tested; the installer and uninstaller are visible by default; no `-alpha`/`-Beta` in the release path; `CONTEXT.md` matches the tree |
| **W1** | 4–5 | Daemon test depth, JS lint, supply chain, browser tests | M2.1–M2.5 | M+M+M+M+M | lint runs on all 153 JS files; the protocol contract test covers every message; lockfile and dependency review in CI |
| **W2** | 6–7 | Runtimes, monolith split, measured performance | M3.1–M3.3 | M+L+M | cold start printed by CI; `desktop_capture.js` and `server.js` split with suites green |
| **W3** | 8–11 | Phone app, daemon/agents, hub, transport reach | M4.1–M4.4 | L×4 | each surface works with the documented transport and has a test |
| **W4** | 12–14 | Transport quality, security depth, stream robustness | M5.1–M5.4 | M+L+M+M | resumable stream measured; revocation verified end to end |
| **W5** | quarter | Machine-owner policy, publication, operability | M6.1–M6.4 | M | policy surfaced in the UI; a third party can run it from the docs |

Wave rules: W0 is doc and default-behaviour work and must land first — a
remote-control tool that installs invisibly is the risk, not the missing tests.
W2's split waits for W1's lint so the refactor is mechanical.

---

## 8. Dependencies and the critical path

```
M1.3 (visibility)      → M6.1 (owner policy)   → W5 claims
M1.4 (alpha deps)      → M3.1 (runtimes)
M1.6 (device tests)    → M4.1 (phone app)
M2.1 (daemon depth)    → M3.2 (split)          → M5.3 (stream robustness)
M2.4 (browser tests)   → M3.2.2 (hub refactor)
M5.1 (transport)       → M4.4 (reach)
```

Critical path: **M1.3 → M2.1 → M3.2 → M5.3**. Visibility and tests are what let the
refactor happen at all; the transport work is the product's differentiator and needs
the seams.

Do not start: M3.2 before M2.1 (splitting 1,905 untested lines is a rewrite); M4.x
before M1.6 (no device truth); M6.1 before M1.3 (policy on top of invisible installs
is theatre).

---

## 9. Verification harness (commands that exist today)

| Purpose | Command | Status |
|---|---|---|
| Daemon tests | `cd daemon && npm test` (`node --test`, 50 `*.test.mjs` files) | exists |
| Daemon start / TLS setup | `npm start`, `npm run setup-tls` | exists |
| Android | `./gradlew lintDebug testDebugUnitTest assembleDebug` (72 `@Test`, no instrumented run) | exists (`ci.yml:72`) |
| Native helpers | `cargo test --release` | exists (`ci.yml:112-134`) |
| CI jobs | 3: `daemon`, `android`, `native` | exists |
| **JS lint / format** | — | **missing** (M2.2) |
| **Instrumented Android tests** | — | **missing** (M1.6) |
| **Cold start number** | — | **missing** (M3.3) |
| **Browser client tests** | — | **missing** (M2.4) |
| **Protocol contract as a gate** | `protocol-contract.test.mjs` exists; not enforced as exhaustive | partial (M2.1) |

---

## 10. Risk register

| # | Risk | Prob | Impact | Detection | Mitigation |
|---|---|---|---|---|---|
| R1 | Stealth install / elevation / silent restart ship as default | High | Trust, legal | `docs/INTEGRITY.md` says plan only; code is default | M1.3 |
| R2 | No quit path | High | User cannot stop it | no tested quit | M1.2 |
| R3 | AGP alpha + Kotlin beta in the release path | High | Broken release | `libs.versions.toml:2,3` | M1.4 |
| R4 | 1,905-line capture module with no seams | High | Risky change | `wc -l` | M3.2 after M2.1 |
| R5 | Plaintext leaking over a non-`wss` path | Low | Privacy | manifest + phone refusal | keep the invariant test |
| R6 | A token reaching the phone on account switch | Low | Credential leak | masked restore | test in M2.1 |
| R7 | `node-pty` beta breaking terminals | Med | Feature outage | none today | pin + upgrade test |
| R8 | Docs describing a transport that moved | High | Wrong mental model | `CONTEXT.md` stale | M3.3 |
| R9 | Protocol message added without a test | Med | Silent breakage | contract test partial | M2.1 |
| R10 | Android never runs on a device in CI | High | Runtime-only bugs | `ci.yml` compiles only | M1.6 |

---

## 11. PR batching and rollback

| Batch | Contents | Rollback |
|---|---|---|
| B1 | `INTEGRITY.md` rewrite + visibility defaults | revert; installer returns to previous defaults |
| B2 | quit path + test | revert |
| B3 | lint adoption + first 20 files fixed | revert lint config |
| B4 | `desktop_capture` split (4 PRs) | revert per module |
| B5 | `server.js` + hub split | revert per module |
| B6 | transport docs regenerated | revert docs |

Rollback rules: the daemon has no migration state; a revert is a restart. Protocol
changes are additive (a new message) or versioned, never an edit in place.

---

## 12. Progress metrics

| Metric | Now (measured) | W1 | W3 | How measured |
|---|---|---|---|---|
| JS files | 153 outside `node_modules` | linted 100% | same | `find`+`wc` |
| Daemon test files | 50 | + protocol coverage | + transport | `ls daemon/test/*.test.mjs` |
| Android `@Test` | 72 | + instrumented | + instrumented | `grep -rho @Test` |
| Largest source file | 1,905 (`desktop_capture.js`) | same | < 600 | `wc -l` |
| Release-path alpha/beta deps | AGP alpha, Kotlin beta | 0 | 0 | `libs.versions.toml` |
| Instrumented tests in CI | 0 | ≥1 | full | CI log |
| Cold start | unmeasured | measured | budgeted | CI print |

---

## Appendix A — Blocked on the owner

From `docs/INTEGRITY.md` §6, these decide Phase 1.2 and Phase 6.1 and cannot be
guessed:

1. Unelevated default install, elevation opt-in — yes/no?
2. No silent auto-restart — yes/no?
3. Visible tray plus logon notice — yes/no?
4. Console (SYSTEM / secure desktop) endpoint: drop from public builds, or keep admin-only?
5. Virtual webcam: default off + watermark, or watermark only?
6. Kill-switch scope: remote control only, or all four keys?
7. Publish the vendor detection document — yes/no?
8. Remove the "invisible to anti-cheat and antivirus" claim and the AMSI framing — recommended yes.

From the absorbed plans and `docs/INTEGRITY.md` (needs real hardware, no agent can do it):

- Phone run: foreground service, biometric lock, QR pairing on a real device.
- Windows hardware check: no window flash during chat, git and desktop streams.
- KVM mesh across three real PCs.
- Real-phone mobile-data transport measurement.

## Appendix B — Definition of done

1. A failing test exists before the fix; daemon tests run on Linux, macOS and Windows for anything touching the platform layer.
2. `npm test`, `./gradlew lintDebug testDebugUnitTest assembleDebug`, and the Rust helper tests pass; output pasted.
3. No invariant in §0 broken: wss-only, settings on the PC, tokens on the PC, no evasion work.
4. No new pre-release dependency without a documented blocker.
5. Docs updated in the same PR; `CONTEXT.md` and the feature table never describe a tree that no longer exists.

## Appendix C — Evidence ledger

| Claim | Command | Result | Status |
|---|---|---|---|
| 153 JS/MJS files (150 in `daemon/`) | `find . -name '*.js' -o -name '*.mjs' \| grep -v node_modules \| wc -l` | 153 / 150 | verified-here |
| `daemon/src` 16,373 lines | `find daemon/src -name '*.js' -exec cat {} + \| wc -l` | 16,373 | verified-here |
| 50 daemon test files | `ls daemon/test/*.test.mjs \| wc -l` | 50 | verified-here |
| `desktop_capture.js` 1,905 / `server.js` 956 | `find … -exec wc -l {} + \| sort -rn` | 1,905 / 956 | verified-here |
| Vendored `qrcode.min.js` 2,298 (not ours) | same | 2,298 | verified-here |
| `node-pty 1.2.0-beta.15`, `ssh2 ^1.17.0`, `ws ^8.22.0`, iroh `^1.1.0` | read `daemon/package.json` | as stated | verified-here |
| 73 Kotlin files, 72 `@Test` | `find app -name '*.kt'`, `grep -rho @Test` | 73 / 72 | verified-here |
| AGP `9.5.0-alpha09`, Kotlin `2.5.0-Beta1` | `app/gradle/libs.versions.toml:2-3` | as stated | verified-here |
| Android CI compiles only | `sed -n '60,80p' .github/workflows/ci.yml` | `lintDebug testDebugUnitTest assembleDebug` | verified-here |
| 3 CI jobs | `grep -nE '^  [a-z]+:' .github/workflows/ci.yml` | daemon, android, native | verified-here |
| 4 plugins | `ls daemon/src/plugins` | auth, logger, metrics (+ registry) | verified-here |
| "247 JS files" | earlier count | **wrong** | corrected to 153 |
| "28 suites" badge | README only | doc claim | needs-verify |

## Appendix D — Absorbed plans (both executed, both deleted)

`docs/roadmap-design.md` and `docs/console-endpoint-plan.md` are gone. This appendix
keeps what they said that still matters: the out-of-scope decisions, the console
endpoint's architecture, and the manual checks that never ran.

### Out of scope by decision (from `roadmap-design.md` Part 3)

- **WebRTC.** Node has no first-class WebRTC stack, so it would mean a native dependency
  or a sidecar; iroh already provides the NAT traversal, relay fallback and loss-tolerant
  QUIC that WebRTC would add, and the measured H.264-over-iroh path meets the latency goal.
  Revisit only if a real-phone mobile-data measurement shows it falling short.
- **E2EE shares.** The share feature no longer exists.
- **Phone-side device or TOTP management.** Moved to the PC on purpose.
- **A CA-issued certificate or mkcert.** Pinning a self-signed certificate is equally strong
  for a paired phone.
- **Linux desktop viewing** stays out of scope; the Linux daemon runs hidden and opens the
  settings page instead.

### Console (SYSTEM / secure-desktop) endpoint — architecture

- Purpose: reach the lock screen, a UAC prompt and the pre-login desktop from the phone.
- Shape: a C# launcher (`daemon/scripts/console/PocketDeskConsole.cs`, 207 lines) installed as
  the scheduled task `PocketDeskConsole`, running as SYSTEM on port **8766**; the ordinary
  user daemon stays on **8765** and still cannot approve UAC.
- Env: `RH_CONSOLE` (console mode), `RH_LABEL` (the second pairing entry's name), `RH_HOME`.
  `IS_CONSOLE` is read at module load, so tests must drive it through a subprocess.
- Wiring that exists: `install-service.ps1 -Console` (elevated), `uninstall-service.ps1`,
  root `install.ps1`, and a `doctor` check that reports the task registered/daemon down.
- Docs still to write: a "Console access" section in `docs/SETUP-PC.md` and the console module
  in `CONTEXT.md` (new module, ports 8765/8766, the three envs, the scheduled-task launcher).

### Manual checks that have never run (needs one elevated session on real hardware)

1. `install-service.ps1 -Console` elevated: the task registers and `https://localhost:8766/health` answers.
2. Scan the "PC (console)" QR from `/pair`; a second entry appears in the app.
3. From the phone, approve a UAC prompt on the PC (run any installer).
4. Lock the PC (Win+L); unlock it from the phone by typing the password.
5. Reboot and reach the logon screen from the phone before logging in (proves before-login plus iroh from the SYSTEM key).
6. Confirm the user daemon (8765) still cannot approve UAC.
7. Elevated `uninstall-service.ps1`: the task and processes are gone and the paired token survives unless `-Purge`.

### Status notes from the last re-check (2026-11-22), kept because they contradict earlier claims

- **wss only (2.1) — a gap was found and fixed.** A plaintext daemon was binding `0.0.0.0:8899`
  and `[::]:8899`, not loopback; the old test passed only because Windows Firewall refused the
  LAN connection. `server.listen` now binds `127.0.0.1` whenever TLS is off.
- **Settings on the PC (2.2) — verified**: `/access/devices` answers 200 with the key and 403
  without it; `POST /access/totp` answers 403 without a key.
- **Task Manager only (2.3) — verified except the window-flash check**: the Start Menu has
  `PocketDesk.lnk`, the Desktop has none, and the helpers pass `windowsHide`.
- Still open from that session: the on-device phone run and the macOS H.264/Retina check.


---

## Journal

- 2026-11-24 m1.1.1 [x] README "Responsible use", INTEGRITY.md committed | proof: `grep -A8 "### Responsible use" README.md` -> two prohibitions + reason at :688 | next: m1.1.2
