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
- [x] Remove every "invisible to antivirus / anti-cheat" and AMSI claim from `README.md`, `CONTEXT.md`, `EXCLUSIVE-FULLSCREEN.md` and the `desktop_capture.js` header comment. `[C]`
  verified-here: `grep -rniE "amsi|anti-?cheat|invisible to" --include='*.js' --include='*.mjs' --include='*.md' . | grep -v node_modules | grep -v plan.md | grep -v INTEGRITY.md` → 2 hits, both legitimate: `EXCLUSIVE-FULLSCREEN.md:23` lists anti-cheat bans as a *cost of someone else's* DLL-hooking approach, `README.md:356` says DRM content is invisible to capture APIs. Zero claims about PocketDesk; `CONTEXT.md` had none; `node --check src/desktop_capture.js` → OK
- [x] Add the `CONTRIBUTING.md` rule (no anti-detection, no anti-forensics, no driver, no enumeration hiding) and a grep-able list of banned patterns. `[C]`
  verified-here: `cd daemon && node --test test/no-evasion.test.mjs` → 8 PASS / ALL PASS; the copy-paste gate in `CONTRIBUTING.md` ("No detection evasion, ever") → no output, `grep` exit 1 (clean) over 252 scanned files
- [x] Link `docs/INTEGRITY.md` from README and CONTRIBUTING; keep it as the standing statement. `[C]`
  verified-here: `grep -n 'INTEGRITY.md' README.md CONTRIBUTING.md` → `README.md:697` (end of Responsible use) and `CONTRIBUTING.md:184,193`; the file is committed in `7c830b4`, so both links resolve

### M1.2 Be closeable

**Why:** `install.ps1` re-runs `install-service.ps1 -Protect` under UAC and
registers `-RunLevel Highest` with `RestartCount 3`; an elevated, self-restarting
daemon is the one control a native integrity client cannot beat.
**Done when:** the default install can be stopped by the machine owner and stays
stopped.

- [x] Default install runs unelevated (`RunLevel Limited`, per-user task, data under `%LOCALAPPDATA%`); `-Protected`/`--elevate` becomes an explicit advanced flag with a warning that it is uncloseable by ordinary apps. `[C]`
  verified-here: `cd daemon && node --test test/installer.unit.test.mjs` → 24 checks ALL PASS (default task `-RunLevel Limited`, no `-Verb RunAs` in the default region); `powershell -NoProfile -Command '[Parser]::ParseFile(...)'` → PARSE OK on `install.ps1`, `install-service.ps1`, `uninstall.ps1`; `csc -target:winexe daemon\scripts\PocketDeskLauncher.cs` → CSC OK
  deviation: data stays in `%USERPROFILE%\.pocketdesk` — already per-user and user-writable; moving it would orphan every paired phone and token with no migration path (§11 rollback = restart). The security property the item asks for (no elevation, folder the user owns) holds.
  deviation: the default install no longer adds the `PocketDesk (daemon)` firewall rule (`New-NetFirewallRule` needs admin); Windows asks once on first listen and the answer is the user's. `-Protected` keeps the rule.
- [x] Remove `RestartCount` from the default task; a stop is a stop, and the next start is a user action. `[C]`
  verified-here: `cd daemon && node --test test/installer.unit.test.mjs` → 25 checks ALL PASS, including "a stop stays stopped: the default task does not restart itself"; `powershell -Command '[Parser]::ParseFile(...)'` → PARSE OK
  deviation: the `-Protected` task keeps `-RestartCount 3` (that path is the explicit "uncloseable" opt-in, and its removal is Appendix A question 2 — an owner decision, not an agent's).
- [x] `pocketdesk stop` terminates the PowerShell, ffmpeg and helper children, and asserts nothing re-arms capture or input. `[C]`
  verified-here: `cd daemon && node --test test/stop-cli.test.mjs` → 11 PASS / ALL PASS (daemon, terminal child and a helper-shaped process from `<RH_HOME>\helpers` all gone; both ports closed; still closed 3 s later). Before: `node /tmp/old-cli.js stop` → `pocketdesk: unknown command: stop`, exit 1
  needs-verify: the ffmpeg child and the real PowerShell capture/input helpers need a live desktop session on Windows hardware; the sweep matches any process whose command line names `<RH_HOME>\helpers`, which is where `desktop_capture.js:474` writes them.
- [x] Test in `daemon/test`: a simulated lockdown client enumerates processes, reads the scheduled task, kills every PocketDesk process, then asserts nothing is left and nothing returns. The same test against the current build must fail — that is the regression oracle. `[C]`
  verified-here: `cd daemon && node --test test/lockdown-client.test.mjs` → 9 PASS / ALL PASS. Oracle: the same two task assertions against `git show 25969a6:daemon/scripts/install-service.ps1` → `Limited: false | Highest: true | RestartCount: true`, i.e. the pre-fix installer fails them
  needs-verify: the live half registers no real scheduled task (that would modify the machine), so "nothing returns" is proven for processes and ports, not for Task Scheduler itself; that needs one install + kill on the owner's hardware.
- [x] `pocketdesk --status` prints elevated (yes/no), auto-start, restart policy, ports and data folder, one line each. `[C]`
  verified-here: `cd daemon && node --test test/status-cli.test.mjs` → 10 PASS / ALL PASS; on this machine `RH_HOME=$TEMP/pd-status-test RH_PORT=8865 node src/cli.js --status` → `elevated: yes — ordinary programs cannot stop the daemon` / `auto-start: yes — scheduled task 'PocketDesk' (HighestAvailable)` / `restart policy: 3 restarts, 1 min apart`, read from the live task XML, not hard-coded

### M1.3 Visibility

- [x] Tray icon with Stop / Open settings / Uninstall, and a one-time "PocketDesk is running" notice at logon. `[C]`
  verified-here: `cd daemon && node --test test/installer.unit.test.mjs` → 28 checks ALL PASS (tray offers open/stop/uninstall, disappears with the daemon, shows the notice once, compiled into the launcher); `csc -target:winexe -r:System.Windows.Forms.dll -r:System.Drawing.dll PocketDeskLauncher.cs PocketDeskTray.cs` → CSC OK
  deviation: under Smart App Control the autostart path is `conhost` + `run-daemon.ps1` (a signed-binary workaround), so no tray is running there. needs-verify: one SAC machine.
  needs-verify: nobody has clicked the tray on Windows hardware yet; the menu items, balloon and Stop are compiled and statically checked, not exercised.
- [x] Write start, stop and policy events to the Windows Event Log under source `PocketDesk`, so an external client can read them without guessing. `[C]`
  verified-here: `cd daemon && node --test test/eventlog.unit.test.mjs` → 10 PASS / ALL PASS, including a real write followed by `wevtutil qe Application "*[System[Provider[@Name='PocketDesk']]]"` reading the same message back
  partial: ids 1002/1003 (policy, policy refusal) are wired in `eventlog.js` but nothing emits them yet — M6.1 owns the call site.
- [x] Uninstall removes task, Start Menu entry, firewall rule, `ProgramData` policy and data folder only on confirmation; assert with a test on the installer scripts. `[C]`
  verified-here: `cd daemon && node --test test/installer.unit.test.mjs` → 34 checks ALL PASS, including "uninstall removes the machine policy file", "uninstall asks before deleting settings and paired phones", "the data folder is deleted only in the confirmed branch"; `powershell -Command '[Parser]::ParseFile("uninstall.ps1")'` → PARSE OK
  needs-verify: nobody has run this uninstaller against a real install since the change; the prompt path is parsed and statically checked, not clicked.

### M1.4 Stop the release path shipping alphas

**Why:** the APK users install is built by AGP `9.5.0-alpha09` and Kotlin
`2.5.0-Beta1`; the daemon's PTY layer is `node-pty 1.2.0-beta.15`. Toolchain
pre-releases change R8 and native ABI behaviour between builds of one commit.
**Done when:** release builds use stable versions and a second build of the same
commit is byte-identical.

> Corrected 2026-11-24 (m1.4.4): a signed APK can never be byte-identical — APK
> Signature Scheme v2/v3 signs a salted digest with a random 32-byte salt, so the
> signing block differs between two signings of identical content. Measured on this
> tree: file `sha256` differs between an incremental and a clean build while every
> zip entry (name, size, CRC-32, time) and every byte outside the signing block is
> identical. The check is therefore "same content fingerprint", which
> `app/scripts/apk-content-hash.mjs` prints; see `docs/REPRODUCIBLE-BUILD.md`.

- [x] Pin AGP, Kotlin and Compose to the newest **stable** line that supports `compileSdk 37.2`; record the blocker in a comment if one remains. `[C]`
  verified-here: `cd app && JAVA_HOME=/c/work/jdk21 ./gradlew :app:dependencyInsight --configuration debugCompileClasspath --dependency androidx.compose:compose-bom` → `compose-bom:2026.11.01`, `org.gradle.status = release`; the same for `navigation3-runtime:1.2.2`; `./gradlew -q :app:compileDebugKotlin` → EXIT=0 with AGP 9.5.2, Kotlin 2.4.21, activity 1.13.0, lifecycle 2.11.1, navigation3 1.2.2, kotlinx-serialization 1.13.0
  also: pre-release versions this subtask removed — `agp 9.5.0-alpha09`, `kotlin 2.5.0-Beta1`, `compose-bom-alpha 2026.10.00`, `activity 1.14.0-alpha03`, `lifecycle 2.12.0-alpha04`, `navigation3 1.3.0-alpha02`, `serialization 1.12.0-RC`
- [x] Pin `node-pty` to a stable release, or vendor the beta with an ADR stating the risk and the exit condition. `[C]`
  verified-here: `cd daemon && node -e 'require("node-pty").spawn(...)'` with `node-pty 1.1.0` → `PTY_OK seen`; `node --test test/term-cli.test.mjs test/stream.test.mjs test/crash-kills-agents.test.mjs` → 3/3 suites ALL PASS; `test/ssh-ui.test.mjs` → 1 PASS; clean `npm ci` from the committed lock in an empty dir → `CI PTY OK`
  exit from the beta line: node-pty 1.2.0-beta.15 → **1.1.0** (`latest` dist-tag). The 1.2 line still ships betas only (`1.2.0-beta.18`), so the stable major is the release choice; 1.1.0 publishes win32-x64/darwin N-API prebuilds, so no compiler is needed and Node 26 loads it unchanged.
  not covered: nothing in the tree used a 1.2-only option (`useConpty*` appears nowhere), but the beta's Windows conhost fixes are given up — if a conpty bug shows up on a real desktop, that reopens this decision.
- [x] Add a check that fails the build when `libs.versions.toml` or `package.json` gains a pre-release version without a `# prerelease:` note. `[P]`
  verified-here: `cd daemon && node --test test/prerelease-pins.test.mjs` → 9 PASS on the current tree; with `agp = "9.6.0-alpha01"` and `ws: "8.23.0-beta.1"` injected → `FAILED: 2 — agp=9.6.0-alpha01 line 6; ws@8.23.0-beta.1`; with `# prerelease: …` on the pin and a `"prerelease"` map in package.json → ALL PASS; files restored, `git diff` empty
  also: the note must be on the pin's own line or as the whole comment line above it — a sentence further up that merely mentions `# prerelease:` does not count (found by that first injected run, which passed when it should have failed).
- [x] Reproducible APK: build the same commit twice with the same keystore, compare `sha256sum`, document any non-deterministic input. `[C]`
  verified-here: two `assembleRelease` runs (one incremental, one after `clean`) with a throwaway key → file sha256 `870fe1a7…` vs `3a94e284…` (differ), entry fingerprint `d187d072…` both (511 entries), unsigned-bytes sha256 `a76d5286…` both, block start/length `12021512/12280` both, `apksigner verify` exit 0 both with certificate `61bb67fb…`
  documented: `docs/REPRODUCIBLE-BUILD.md` — the salt in the v2/v3 block, the recipe, and the unpinned inputs (JDK 21.0.12.1, build-tools 37.0.0, platform android-37.2, fetched not vendored dependencies, keystore)
  also: `daemon/test/apk-hash.unit.test.mjs` → 7 PASS (non-zip rejected with a reason, missing argument prints usage, same content fingerprints the same, a changed byte moves it)
  needs-verify: the two builds were of the same working tree, which carried uncommitted edits in `app/app/src`; nobody has repeated this on a second machine with a different JDK.

### M1.5 Make the stale docs true

- [x] Rewrite `CONTEXT.md` from the tree (paths, test entrypoints, plugin location, Android versions) or delete it; a doc that names the wrong files costs more than it saves. `[C]`
  verified-here: counts and paths read from the tree on 2026-11-24 — `ls daemon/src/*.js | wc -l` → 65, `ls daemon/src/handlers/*.js | wc -l` → 13, `ls daemon/manifests/*.json | wc -l` → 17, `ls daemon/src/plugins/*.js | wc -l` → 3, `ls daemon/test/*.test.mjs | wc -l` → 57; versions from `app/gradle/libs.versions.toml` (agp 9.5.2, kotlin 2.4.21, composeBom 2026.11.01) and `app/app/build.gradle.kts` (compileSdk 37.2, minSdk 30, targetSdk 37, versionName 0.11.0); `node src/cli.js status` → `ports: 8765 daemon, 8775 loopback page, 4679 cli`, `EXIT=0`
  removed from the old file: the stale repo path (`C:\Users\yasha\PROJECTS\…`), `AGP 9.5.0-alpha09` / `Kotlin 2.5.0-Beta1`, `JDK 25 to build` (AGP 9.5 takes 17+, 21 was used), "test/smoke.mjs + smoke-chat.mjs" as the only tests (57 files), and the 2026-09/11 state narrative that contradicted `docs/FEATURE-MATRIX.md`
- [x] Fix the "28 suites" badge to the generated test-file count. `[C]`
  verified-here: `grep -n Tests- README.md` → `Tests-58%20files`; `ls daemon/test/*.test.mjs | wc -l` → 58; `cd daemon && node --test test/readme-truth.unit.test.mjs` → 6 PASS; with a dummy `test/zz-tmp.test.mjs` added → `FAILED: 1 — the badge count matches the 59 test files`; file removed → ALL PASS
  also: the badge now counts *files*, which is what one `npm test` entry is, and `readme-truth.unit.test.mjs` re-checks it on every run so the number cannot go stale again.
- [x] `docs/FEATURE-MATRIX.md` and the README feature table re-checked against `handlers/*` message names; a feature with no handler is removed. `[C]`
  verified-here: `cd daemon && node --test test/readme-protocol.test.mjs test/feature-matrix.test.mjs` → 18 PASS; the handler name set is read from `daemon/src/handlers/*.js` (232 types) plus the ones added in `server.js`
  fixed because no handler exists: README listed `totp_status/setup/enable/disable` as WebSocket messages — they are loopback HTTP (`/access/totp/*`, code rides on `hello`); the matrix marked ✅ for `share_*`, `wt_*`, `record_asciicast/record_get`, `lan_*`, `vnc_*`, `notify_*`, `mcp_*`, `quiet_set`, `session_quiet`, `render_digest/digest_*` — 7 rows rewritten, 2 to 🧩 (module exists, no message: `pc_notifs.js`, `worktree.js` via `create {worktree}`)
  also: the 2026-09 "Wired in this pass" protocol section is now labelled historical with the measured split — of 110 names it lists, 38 have a handler today and 72 do not.
  proof the gates bite: adding `share_create` to a ✅ matrix row and to the README client list → `FAIL no ✅ row claims a removed message family` + `FAIL every documented client message has a handler (no handler: share_create)`; both files restored, 18 PASS again.
  needs-verify: the matrix is 356 lines of historical claims; only the rows naming a message were machine-checked. Rows that claim ⚙️ behaviour with no message name (e.g. tmux-backed detach, origin check) were read, not executed.
- [x] `daemon/README`-level statement of every protocol message with its handler file, generated from the registry. `[C]`
  verified-here: `node daemon/scripts/gen-protocol-doc.mjs` → `wrote 222 message types to daemon/README.md` (13 handler files + `src/server.js`); `cd daemon && node --test test/protocol-doc.test.mjs` → 11 PASS incl. "every listed handler file exists"
  proof it bites: pointing the `chatsession` row at `src/handlers/gone.js` → 3 FAIL (stale table, missing file); restored → 11 PASS
  also: the generator imports each handler factory with a stub context and falls back to reading the object literal if a factory needs a live server, printing which file it had to read statically.
- [x] Fold the console-pairing checks into existing suites rather than new files: a pair payload carrying `n` when `RH_LABEL` is set and omitting it otherwise (extend a pairing/protocol test), and a byte-identity test that `DesktopController` output is identical with and without `RH_CONSOLE` (driven through a `node -e` subprocess, because `IS_CONSOLE` is read at module load). `[C]`
  verified-here: `cd daemon && node --test test/auth.test.mjs` → ALL PASS including "pairing QR omits the machine label when RH_LABEL is unset", "pairing QR carries the machine label when RH_LABEL is set" (second daemon on 8834 with `RH_LABEL=Studio PC`); removing `n: process.env.RH_LABEL` from `server.js` → `FAIL pairing QR carries the machine label when RH_LABEL is set`; restored → ALL PASS
  the byte-identity half lives in the new `test/console-parity.test.mjs` (4 checks + guard): two `node --input-type=module -e` subprocesses, with and without `RH_CONSOLE=1`, compare `toFraction`/`fromFraction`/`centerFor` and `ffmpegArgs` for 2 monitors × 3 encoders × 2 platforms → identical strings; forcing `ffmpegArgs` to change under `RH_CONSOLE` → `FAIL console mode does not change capture geometry or encoder args`; restored → ALL PASS
- [x] Write the `docs/SETUP-PC.md` "Console access (lock screen / UAC / before login)" section and add the console module, ports 8765/8766 and `RH_CONSOLE`/`RH_LABEL`/`RH_HOME` to `CONTEXT.md`. `[C]`
  verified-here: the SETUP-PC section already existed and was checked against the installer — `grep -n '8766\|RH_CONSOLE\|console-audit' daemon/scripts/install-service.ps1` → port 8766 guard on line 99/150/153, pairing page on 155, SYSTEM task `PocketDeskConsole` on 161; `daemon/src/server.js:59` → `AUDIT_LOG = console-audit.log` in the console config dir
  added to `CONTEXT.md`: an environment table (`RH_HOME`, `RH_CONSOLE`, `RH_LABEL`, `RH_QUIET_MS`/`RH_IDLE_KILL_MINUTES`/`RH_AWAKE`, `RH_MANIFESTS`), the console endpoint paragraph (opt-in, SYSTEM task, own port/token/phone entry), and the full port list — 8765, +10 loopback page, +20 WebDAV drive (`server.js:866`), 8766 console, 4679 CLI

### M1.6 Android has never run a test on a device in CI

- [x] Emulator CI job (`reactivecircus/android-emulator-runner`, API 26 and 37): `connectedDebugAndroidTest`; start with the pairing and TLS tests. `[C]`
  corrected: the plan said API 26, but `minSdk` is 30 — an API 26 emulator cannot install the app. The matrix is `[30, 37]`: the oldest phone it installs on and the API it targets.
  verified-here: `cd app && JAVA_HOME=/c/work/jdk21 ./gradlew :app:assembleDebugAndroidTest` → BUILD SUCCESSFUL; then on the local emulator (`adb devices` → `emulator-5556`, AVD `ping_ci34`, API 34): `./gradlew :app:connectedDebugAndroidTest` → BUILD SUCCESSFUL in 4m 13s, and `app/app/build/outputs/androidTest-results/connected/debug/TEST-*.xml` → `tests="11" failures="0"` — 7 pairing + 4 TLS cases, e.g. `thePairedFingerprintIsAccepted`, `aDifferentFingerprintIsRefused`, `theDaemonsOwnLinkShapeIsUnderstood`
  added: `app/app/src/androidTest/.../PairingInstrumentedTest.kt` (7 cases, Android's own base64/JSON) and `TlsInstrumentedTest.kt` (4 cases, a real handshake against a `HeldCertificate` server: pinned accepts, wrong pin refuses, collecting trust manager reports the leaf fingerprint), `testInstrumentationRunner`, and `androidx.test:{junit 1.3.0,runner 1.7.0,core}` + `okhttp-tls` under `androidTestImplementation`
  also: `daemon/test/android-ci.unit.test.mjs` (15 checks) ties the workflow to the build file — the matrix must contain `minSdk` and `targetSdk` read from `build.gradle.kts`, so bumping either without touching CI fails.
  needs-verify: the GitHub job itself has not run (no Actions here). Its YAML parses with `npx js-yaml` and the same Gradle task passed locally on API 34; API 30 and 37 runner images are unproven.
- [x] Robolectric (or Roborazzi) tests for the five main screens so layout can be checked without hardware. `[C]`
  corrected: Robolectric cannot render these screens. Every screen takes a `WsClient`, whose class pulls in iroh's uniffi bindings; on the JVM that is `UnsatisfiedLinkError: no iroh_ffi in java.library.path` for all 7 attempts, once `unitTests.isIncludeAndroidResources = true` and a debug-manifest `ComponentActivity` were in place (the earlier `Unable to resolve activity` was that missing manifest, not the screens).
  done instead: `app/app/src/androidTest/.../ScreensRenderTest.kt` — 6 on-emulator Compose cases over Connect ("Scan QR" + "Phone to phone"), Sessions ("New session"), Chat ("Chats" + "No active chats"), SSH and Deck toolbars, plus an unconnected `WsClient` that must still draw. Layout is now checked without a handset, on the emulator job from m1.6.1.
  verified-here: `cd app && JAVA_HOME=/c/work/jdk21 ./gradlew :app:connectedDebugAndroidTest` on AVD `ping_ci34` (API 34) → BUILD SUCCESSFUL, `TEST-ping_ci34(AVD) - 14.xml` → `tests="17" failures="0"` (7 pairing + 4 TLS + 6 screens). Perturbation `assertShown("No active chats")` → `"No active chats AT ALL"` → that case FAILS with `never appeared`, so the assertions bite.
  needs-verify: the assertions retry for 20 s before failing because this AVD is dirty (a leftover `com.ping.app.debug` steals the foreground and one earlier run failed `No compose hierarchies found`); a fresh CI emulator has no such app, but this is the first thing to suspect if the job goes red.
- [ ] Roborazzi screenshots of the same five screens (golden images, not just presence) — Roborazzi shares Robolectric's runtime, so it is blocked on the same iroh native load. Wants an iroh shim (a `expect/actual` link layer) before it is worth attempting. `[C]`
- [x] Instrumented test for `LinkService` foreground start, background survival and stop. `[C]`
  done: `app/app/src/androidTest/.../LinkServiceInstrumentedTest.kt`, 5 cases — starting it creates the `link` channel named "Connection" at `IMPORTANCE_LOW`; an already-ended link still reaches `startForeground` and then stands down leaving no notification behind; the Disconnect action clears the saved PC (`pocketdesk`/`last_pc`); an Allow intent with no `EXTRA_ID` takes the ordinary start path instead of reading a null proposal; and `onBind` hands out no binder, so the service cannot die with the UI.
  verified-here: `cd app && JAVA_HOME=/c/work/jdk21 ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.yasha.pocketdesk.LinkServiceInstrumentedTest` on AVD `ping_ci34` (API 34) → `tests="5" failures="0"`. Perturbed `LinkService.kt`: renamed the channel to "Link daemon" and commented out `forgetAutoConnect(this)` → `tests="5" failures="2"`, exactly `startingItCreatesTheLinkChannel` and `theDisconnectActionForgetsTheSavedPc` (the latter after its 15 s wait); restored → 5/5.
  needs-verify: "survival in the background" is not proven, only that the service starts in the foreground and stands down correctly — backgrounding the app needs a UI automation step, and the notification itself is invisible to `activeNotifications` unless POST_NOTIFICATIONS is granted at runtime, neither of which this test does.
- [x] Instrumented test for `AppLock` re-lock after 30 s background. `[C]`
  changed: `AppLock.shouldLock()` now delegates to a pure `internal fun decide(enabled, available, locked, stoppedAt, now)` and `GRACE_MS` is `internal`, so the window is testable without a phone that has a PIN. Behaviour of the class is unchanged.
  verified-here: `:app:testDebugUnitTest --tests "*AppLockWindowTest*"` (JVM) → `tests="8" failures="0"`, including `the boundary itself still does not lock but a millisecond more does` (30 000 ms → open, 30 001 ms → locked) and `a phone with no screen lock is never gated`. Perturbed `GRACE_MS = 20_000L` → `the grace window is thirty seconds` FAILS; restored → 8/8. On the emulator: `connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.yasha.pocketdesk.AppLockInstrumentedTest` → `tests="3" failures="0"` (switch off by default and persisted, `available` mirrors `KeyguardManager.isDeviceSecure`, a stop + immediate return spends no prompt).
  needs-verify: the real 30 s background re-lock has not been observed — that needs a phone with a PIN and half a minute of wall clock, so the window is covered by the pure decision plus a JVM boundary case, not end to end.
- [x] Instrumented test that a `ws://` QR payload is rejected with the documented message. `[C]`
  changed: the message is now `Pairing.REJECTED` (KDoc says why a `ws://`-only link is refused: no TLS means the master token would cross the LAN in the clear), and `ConnectScreen`'s scanner toast uses it instead of an inline literal.
  verified-here: `connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.yasha.pocketdesk.PairRejectInstrumentedTest` on AVD `ping_ci34` (API 34) → `tests="5" failures="0"` (`theRejectionMessageIsTheDocumentedOne`, `aPlainWsLinkIsRejectedWithThatMessage`, `aQrFromAnotherAppIsRejected` incl. a Wi-Fi QR and an empty string, `aWsLinkMissingItsTokenIsRejectedToo`, `theSameLinkWithAnIrohTicketIsAcceptedOverIroh`). Perturbed `Pairing.kt`: text → `"Not a pairing QR"` and the `wss://` guard → `if (false)` → `tests="5" failures="3"`, exactly `ComparisonFailure expected:<Not a [PocketDesk ]pairing QR>`, `a ws:// link must not parse`, and the iroh fallback case; restored → 5/5.
  full suite afterwards: `:app:connectedDebugAndroidTest` → `tests="30" failures="0"` across 6 classes (Pairing 7, TLS 4, Screens 6, LinkService 5, AppLock 3, PairReject 5).

---

## Phase 2 — Preventive

### M2.1 Daemon test depth

- [x] Coverage via `c8` with a floor per `src/` area; ratchet up only. `[P]`
  measured first, then set: `npm run coverage` (c8 12.0.0, `json-summary`) over the whole suite → statements 58.42% (9774/16728), branches 69%, functions 38.1%. Per area: `src` (65 top-level files) 64.7% st / 69.0% br / 52.6% fn, `handlers` (13) 37.6 / 56.2 / 7.1, `phone_adb` (6) 32.7 / 92.9 / 1.4, `plugins` (3) 88.1 / 93.3 / 83.3.
  added: `daemon/coverage-floors.json` (per-area `measured` + `floor`, 4 points below), `scripts/coverage-areas.mjs` (the grouping), `scripts/check-coverage.mjs` (prints each area, exits non-zero naming what slipped, and fails a floor whose area no longer exists), `npm run coverage` / `npm run coverage:areas`, and `test/coverage-floors.test.mjs` (25 checks: every folder of `src/` has a floor, no floor above what was measured, no floor more than 6 points below it, so a stale floor must be tightened).
  verified-here: `node scripts/check-coverage.mjs` → 4 × PASS + "all coverage floors met" (EXIT=0); forcing `handlers.floor.statements = 90` → `FAIL handlers … under floor: statements 90%` and `handlers: statements 37.6% < floor 90%` (EXIT=1); restored → met again. Guard test: `node --test test/coverage-floors.test.mjs` → ALL PASS, and it first failed on its own initial data (the functions floors had been set 8 points low) → tightened to 4 points.
  ratchet rule now documented in `CONTRIBUTING.md` ("Coverage floors only go up"): raise the floor and the `measured` number in the same commit, never lower either.
  needs-verify: `npm run coverage` has not run in CI yet (it is a suite-length job, ~114 s here); the numbers are this machine's.
- [x] `protocol-contract.test.mjs` is the contract: assert every message in the registry has a handler, a doc line and a round-trip test; unknown type returns the documented error. `[P]`
  verified-here: `cd daemon && node --test test/protocol-contract.test.mjs` → ALL PASS, `tests 1 / pass 1 / fail 0`; an unknown type answers `unknown type: no_such_message_type` and the same socket still answers afterwards.
- [x] Failure injection: kill a PTY child mid-stream, drop the socket mid-transfer, corrupt a chunked `fread`; each asserts a user-visible error and no orphaned process. `[P]`
  verified-here: `cd daemon && node --test test/failure-injection.test.mjs` → ALL PASS, `tests 1 / pass 1 / fail 0`; after the kill the PTY and its child are gone, the transfer resumes at the offset the client asks for, and every corrupted read answers without a restart.
- [x] Added 2026-11-24 (measured): make the daemon suite green before deepening it. Result: **115 tests, 115 pass** (`EXIT=0`), where the session started at 113 tests / 108 pass. `[P]`
  what was actually broken, in the order it was found:
  1. tests waited a fixed 0.5–2 s for a daemon that needs 5–7 s cold → `waitForHealth`/`waitForUrl` (see the subtask above).
  2. `local-page` probed `/health` over plain HTTP on a port that serves TLS, so the probe never succeeded → it waits on the loopback page now.
  3. the guard test's own ports were hardcoded, so a daemon leaked by an interrupted run made it `EADDRINUSE` → the OS picks free ports, and `startDaemon` now rejects `.ready` with "port N is already in use — a previous test run left a daemon behind".
  4. four raw `spawn`s did not set `RH_CLI_PORT`, so parallel daemons fought over 4679 (`cli unavailable: listen EADDRINUSE`); it made `approvals` time out on a proposal.
  5. `sessions_scan` shelled out to `tasklist` (~6 s idle, far worse loaded) and *awaited* it, and its old 8 s timeout answered `error` under load; it now shares one in-flight probe, caches 30 s, and never makes a caller wait more than 2 s (the answer carries `refreshing: true` instead).
  6. `absorb` wrote the device registry to the real home, so `welcome echoes clientId` failed once `test-device-1` had a token from an earlier run (the daemon then mints a random id, which is correct) → per-run data dir.
  7. `POCKETDESK_DATA` was joined onto `os.homedir()`, so an absolute path became `C:\Users\Yash\C:\Users\Yash\…`; `path.resolve` (6 modules + the logger plugin) lets a temp data dir actually isolate the suite from the user's profile.
  8. `bastion` sampled the byte counters once, racing the channel teardown → it asks again until the numbers land.
  verified-here: `cd daemon && npm test` → `EXIT=0`, `tests 115 / pass 115 / fail 0`. Every fix was reproduced red first: `absorb` failed alone then passed; `absorb`+`desktop`+`iroh`+`approvals` at `--test-concurrency=4` went 1 fail → 0.
  guard: `test/startup-readiness.test.mjs` is now 10 checks — no pre-connect sleep ≥1 s, a real readiness wait in every spawner, `RH_CLI_PORT` in every raw spawn, no two files declaring the same port, plus the helpers exercised live, on a dead port and against a squatted port.
  needs-verify: timings are from this machine (Windows 11, 498 processes); the `tasklist` cost on a GitHub runner is unmeasured, and with the bounded wait the phone may see `refreshing: true` on its first scan.
- [x] Leak guards: `sessions-leakguard` exists; extend it to 100 create/kill cycles and to the phone-adb and desktop-video paths, asserting handle and memory stability. `[P]`
  verified-here: `cd daemon && node --test test/sessions-leakguard.test.mjs` → ALL PASS, `tests 1 / pass 1 / fail 0`, EXIT=0; handles 415 → 773 over 90 cycles (node-pty native floor 3.55/cycle, bound 6), RSS 138 MB → 129 MB, phone 773 → 773, desktop 773 → 773, video resources 7 → 7.
- [ ] Filesystem safety: every `fs_op` path resolved and confined; tests for `..`, symlinks, `\?\` prefixes, and Windows reserved names. `[P]`
- [ ] Windows-only code paths (`ConPTY`, `SendInput`, `Task Scheduler`) get a CI job on `windows-latest`; they are the least covered and most used. `[P]`
- [x] Added 2026-11-24 (measured): the suite is 113 tests, 108 pass, 5 fail on this machine — `absorb`, `graceful-shutdown`, `sessions-leakguard`, `smoke`, `smoke-chat`. `smoke` and `smoke-chat` fail on a fixed 1.5 s wait for daemon startup; the daemon needs ~5–7 s from a cold cache here (measured with a stdout timestamp probe), so replace every fixed sleep with a readiness wait on the banner or `/health` and re-measure. `[P]`
  done: `waitForHealth(port, timeoutMs)` in `test/helpers.mjs` polls `GET /health` until the daemon answers (`healthy`), because the `registry scanned` banner is printed before the listeners are up — connecting on the banner alone is the race. Used in `smoke`, `smoke-chat`, `graceful-shutdown`, `sessions-leakguard`, `absorb`, `local-page` and `stop-on-stdin-eof` in place of the fixed 500–2000 ms waits.
  verified-here: each file run on its own → `smoke` baseline first reproduced red (`SMOKE ERROR:`, `1 FAILURE(S)`, EXIT=1) then `ALL PASS` (14 checks); `smoke-chat` ALL PASS (7), `graceful-shutdown` ALL PASS incl. "health endpoint reports 0 sessions after kill", `sessions-leakguard` ALL PASS, `absorb` ALL PASS.
  guard: new `test/startup-readiness.test.mjs` (6 checks) — no daemon-spawning test may sleep ≥1000 ms before its first connect, every spawner must make a real readiness wait (`await waitForHealth(` or `.ready`), and `waitForHealth` is exercised against a live daemon and against a dead port (gives up in ~1.5 s naming the port). Perturbed `sessions-leakguard` back to a 2000 ms sleep → `FAIL no file sleeps a second or more before connecting: sessions-leakguard.test.mjs (2000 ms)`; deleting the wait call from `stop-on-stdin-eof` → `FAIL every spawner waits on a readiness signal`; both restored → ALL PASS.
  needs-verify: the whole suite has not yet been re-measured in one parallel run — an interrupted run showed `absorb`, `local-page`, `smoke` and `ssh-ui` red under ~6 daemons at once, so the next step is one clean `npm test` and, if those still fail, a per-port/CPU investigation (they pass individually).

### M2.2 Lint and format for JavaScript

- [ ] The daemon has no linter; add ESLint (flat config) + Prettier, blocking, with `node --check` kept as the cheap first gate. `[P]`
- [ ] Add `--experimental-strip-types`-free JSDoc types and `tsc --checkJs --noEmit` on `src/` with a per-file allowlist that shrinks. `[P]`
- [ ] Ban `child_process.exec` with interpolated strings; allow only `execFile`/spawn with an argv array. `[P]`
- [x] Assert no `shell: true` outside `scripts/`. `[P]`
  verified-here: cd daemon && node --test test/shell-flag-guard.test.mjs → ALL PASS (3 checks, 156 files walked), exit 0

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

- [x] `docs/RUNBOOK.md`: daemon will not start, phone cannot pair, stream black, PTY dead, task missing, policy refused, relay down — each with the first diagnostic command. `[E]`
  verified-here: grep -n ^## docs/RUNBOOK.md -> 7 sections; every quoted command run here (status/pair/list/pty/schtasks/reg/netstat/log greps) -> outputs in evidence/PocketDesk/PocketDesk-t82.md
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
- 2026-11-24 m1.1.2 [x] AMSI/invisibility claims removed from desktop_capture.js header + capture comment, EXCLUSIVE-FULLSCREEN.md, FEATURE-MATRIX.md | proof: `grep -rniE "amsi|anti-?cheat|invisible to" …` -> 2 hits, both about other tools/DRM, none about PocketDesk; `node --check src/desktop_capture.js` -> OK | next: m1.1.3
- 2026-11-24 m1.1.3 [x] CONTRIBUTING "No detection evasion, ever" + banned-pattern grep; new daemon/test/no-evasion.test.mjs enforces it | proof: `node --test test/no-evasion.test.mjs` -> 8 PASS/ALL PASS; documented grep -> no output (exit 1) | next: m1.1.4
- 2026-11-24 m1.1.4 [x] INTEGRITY.md linked from README and CONTRIBUTING | proof: `grep -n INTEGRITY.md README.md CONTRIBUTING.md` -> README:697, CONTRIBUTING:184,193 | next: m1.2.1
- 2026-11-24 m1.2.1 [x] default install unelevated (per-user task, RunLevel Limited); -Protected is opt-in with a warning; launcher gates UAC on the protected marker | proof: `node --test test/installer.unit.test.mjs` -> 24 PASS; PS parse OK; csc OK | next: m1.2.2
- 2026-11-24 m1.2.2 [x] RestartCount removed from the default task (protected path keeps it, owner decision pending) | proof: `node --test test/installer.unit.test.mjs` -> 25 PASS incl. no-restart check; PS PARSE OK | next: m1.2.3
- 2026-11-24 m1.2.3 [x] `pocketdesk stop`: graceful /shutdown, Windows tree+helper sweep, 3 s re-arm watch | proof: `node --test test/stop-cli.test.mjs` -> 11 PASS; old CLI -> "unknown command: stop" | next: m1.2.4
- 2026-11-24 m1.2.4 [x] lockdown-client oracle test: enumerate (name, helper command line, port owners), kill, assert nothing left/returns | proof: `node --test test/lockdown-client.test.mjs` -> 9 PASS; pre-fix installer fails the task assertions (Highest+RestartCount) | next: m1.2.5
- 2026-11-24 m1.2.5 [x] `pocketdesk --status`: elevated/autostart/restart/ports/data/running, each measured | proof: `node --test test/status-cli.test.mjs` -> 10 PASS; live run reads this machine task XML (HighestAvailable, 3 restarts) | next: M1.3
- 2026-11-24 m1.3.1 [x] tray icon (Open/Stop/Uninstall) + one-time logon notice, compiled into the launcher | proof: installer.unit.test.mjs 28 PASS; csc with WinForms -> CSC OK | next: m1.3.2
- 2026-11-24 m1.3.2 [x] Event Log source PocketDesk: start 1000 / stop 1001 (policy 1002/1003 reserved), best-effort with a one-time warning | proof: `node --test test/eventlog.unit.test.mjs` -> 10 PASS incl. real eventcreate + wevtutil read-back | next: m1.3.3
- 2026-11-24 m1.3.3 [x] uninstall removes task/shortcut/firewall/policy always, data only after -RemoveData or a y answer (-KeepData opts out) | proof: `node --test test/installer.unit.test.mjs` -> 34 PASS; uninstall.ps1 PARSE OK | next: m1.4.1
- 2026-11-24 m1.4.1 [x] Android toolchain pinned to stable: AGP 9.5.2, Kotlin 2.4.21, Compose BOM 2026.11.01, activity 1.13.0, lifecycle 2.11.1, nav3 1.2.2, serialization 1.13.0 | proof: dependencyInsight shows org.gradle.status=release; `./gradlew -q :app:compileDebugKotlin` EXIT=0 (JDK 21, SDK 37.2) | next: m1.4.2
- 2026-11-24 m1.4.2 [x] node-pty 1.2.0-beta.15 -> 1.1.0 (stable latest, N-API prebuilds, no compiler) | proof: spawn+echo PTY_OK, term-cli/stream/crash-kills-agents 3/3 ALL PASS, ssh-ui 1 PASS, clean `npm ci` -> CI PTY OK | next: m1.4.3
- 2026-11-24 m1.4.3 [x] prerelease-pins.test.mjs: un-noted pre-release in libs.versions.toml or package.json fails npm test (note on the pin line, or a "prerelease" map) | proof: 9 PASS clean; injected alpha/beta -> FAILED: 2 with names; noted -> ALL PASS | next: m1.4.4
- 2026-11-24 m1.4.4 [x] reproducible release build measured: signed APK sha256 cannot match (v2/v3 random salt) but content fingerprint can; added app/scripts/apk-content-hash.mjs + docs/REPRODUCIBLE-BUILD.md | proof: two assembleRelease runs -> entry fingerprint d187d072 both, unsigned sha256 a76d5286 both, apksigner verify exit 0 both; apk-hash.unit.test.mjs 7 PASS | deviation: plan "Done when" was wrong (byte-identical signed APK is impossible) and was corrected in place | next: m1.5.1
- 2026-11-24 m1.5.1 [x] CONTEXT.md rewritten from the tree: 65 src modules, 13 handlers, 17 manifests, 3 plugins, 57 test files, stable Android pins, real ports (8765 / +10 / 8766 / 4679) | proof: each count from `ls | wc -l`, versions from libs.versions.toml + build.gradle.kts, `node src/cli.js status` EXIT=0 | next: m1.5.2
- 2026-11-24 m1.5.2 [x] README test badge 28 suites -> 58 files, guarded by readme-truth.unit.test.mjs | proof: 6 PASS; dummy 59th test file -> FAILED with the real count; removed -> ALL PASS | next: m1.5.3
- 2026-11-24 m1.5.3 [x] README + FEATURE-MATRIX re-checked against handler names: TOTP moved to HTTP, 7 dead ✅ rows corrected (2 to module-present), old protocol section labelled historical (38/110 names still live) | proof: readme-protocol + feature-matrix tests 18 PASS; injecting `share_create` fails both | next: m1.6.1
- 2026-11-24 m1.5.4 [x] daemon/README.md protocol table generated from the handler registry (222 messages, 13 files) with a --check gate | proof: gen writes 222 rows; protocol-doc.test.mjs 11 PASS; pointing a row at gone.js -> 3 FAIL | note: README test badge 58 -> 61 (guard caught the 3 new test files) | next: m1.5.5
- 2026-11-24 m1.5.5 [x] pair payload label + console parity folded into suites: `n` only with RH_LABEL; capture geometry/encoder args byte-identical with and without RH_CONSOLE | proof: auth.test.mjs ALL PASS (label checks), console-parity.test.mjs 5 PASS; removing the label or perturbing ffmpegArgs under RH_CONSOLE fails by name; badge 61 -> 62 | next: m1.5.6
- 2026-11-24 m1.5.6 [x] CONTEXT.md gains the env-var table (RH_HOME/RH_CONSOLE/RH_LABEL/...), the console-endpoint paragraph and the full port list; SETUP-PC console section re-checked against the installer | proof: install-service.ps1 lines 99/150/153/155/161 match the doc; server.js:59 audit log, :866 WebDAV port+20 | next: m1.6.1
- 2026-11-24 note: full suite 113 tests / 108 pass / 5 fail (absorb, graceful-shutdown, sessions-leakguard, smoke, smoke-chat) — startup-timing flakes, now tracked as an M2.1 subtask with the measured 5-7 s cold-start figure
- 2026-11-24 m1.6.1 [x] emulator CI job (API 30 + 37, minSdk/targetSdk derived) running connectedDebugAndroidTest, plus 11 instrumented pairing+TLS tests | proof: local `connectedDebugAndroidTest` on ping_ci34 (API 34) -> tests=11 failures=0 BUILD SUCCESSFUL; ci.yml parses via js-yaml; android-ci.unit.test.mjs 15 PASS | deviation: plan said API 26 but minSdk is 30, matrix is [30,37] | next: m1.6.2
- 2026-11-24 m1.6.2 [x] five main screens rendered in an instrumented Compose test | proof: connectedDebugAndroidTest on ping_ci34 -> tests=17 failures=0 (6 screen cases); perturbed expected text -> that case FAILS | deviation: Robolectric rejected (UnsatisfiedLinkError no iroh_ffi in java.library.path on the JVM), so the screens are covered on the emulator, and Roborazzi is a new unticked subtask behind an iroh shim | next: m1.6.3
- 2026-11-24 m1.6.3 [x] instrumented LinkService test (channel, foreground-then-stop, Disconnect forgets the PC, Allow path, no binder) | proof: 5/5 pass on ping_ci34; perturbed channel name + forgetAutoConnect -> exactly those 2 FAIL, restored -> 5/5 | needs-verify: background survival and a visible notification are not covered | next: m1.6.4
- 2026-11-24 m1.6.4 [x] AppLock re-lock window covered: extracted a pure decide() + internal GRACE_MS, JVM boundary test (8) and instrumented test (3) | proof: unit 8/8 and device 3/3 on ping_ci34; GRACE_MS=20000 -> the constant case FAILS; restored -> 8/8 | needs-verify: the real 30 s background re-lock is not exercised (needs a PIN on the phone) | next: m1.6.5
- 2026-11-24 m1.6.5 [x] ws:// QR rejection with the documented message (Pairing.REJECTED, used by the scanner toast) | proof: PairRejectInstrumentedTest 5/5 on ping_ci34; perturbed message + wss guard -> exactly 3 FAIL; restored -> 5/5; full connected suite 30/30 | next: M1.6 complete, continue with M2.1 flake fix
- 2026-11-24 m2.1.1 [x] daemon startup readiness: waitForHealth(/health) replaces fixed 0.5-2 s sleeps in 7 test files; new startup-readiness guard (6 checks) | proof: smoke reproduced red then ALL PASS; smoke-chat/graceful/leakguard/absorb ALL PASS individually; guard perturbations fail by name | needs-verify: full parallel npm test not re-measured (interrupted run showed absorb/local-page/smoke/ssh-ui red under load) | next: one clean full-suite run
- 2026-11-24 m2.1.2 [x] daemon suite green: 115/115 pass (was 108/113) | proof: cd daemon && npm test -> EXIT=0 tests 115 pass 115 | fixed: TLS-vs-HTTP readiness probe, hardcoded guard ports, 4 spawns missing RH_CLI_PORT, awaited 6 s sessions_scan (now shared probe + 2 s bounded wait + refreshing flag), absorb device-registry leak from previous runs, POCKETDESK_DATA joined instead of resolved (6 modules + logger), bastion counter race | guard: startup-readiness 10 checks | needs-verify: tasklist cost on GitHub runners unmeasured | next: M2.1 coverage floor
- 2026-11-24 m2.1.3 [x] c8 coverage floors per src/ area + ratchet guard; suite 116/116 | proof: npm run coverage -> st 58.42%% br 69%% fn 38.1%%, areas src 64.7 / handlers 37.6 / phone_adb 32.7 / plugins 88.1; handlers floor forced to 90 -> check FAILS naming it; coverage-floors guard 25 checks | also: lockdown-client waits for the killed tree instead of 1.5 s | needs-verify: npm run coverage not yet in CI | next: protocol-contract test
