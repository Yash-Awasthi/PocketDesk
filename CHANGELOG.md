# Changelog

Newest first. Each section is headed by the `versionName` in
`app/app/build.gradle.kts`, and `versionCode` only ever moves forward;
`daemon/test/android-ci.unit.test.mjs` enforces both, so a release that forgets
an entry or reuses a build number fails the suite.

Tags before 0.11.0 predate this file.

## 0.11.0

### Corrective
- The default install is unelevated and stays stopped: a per-user task at
  `RunLevel Limited` with no restart policy, and `-Protected` is the explicit
  opt-in for an elevated daemon.
- Tray icon with Open, Stop and Uninstall; `pocketdesk stop` also kills the
  PowerShell, ffmpeg and helper children; `pocketdesk --status` prints
  elevation, auto-start, restart policy, ports and the data folder.
- Start, stop and policy events go to the Windows Event Log under `PocketDesk`.
- Android builds on stable releases (AGP 9.5.2, Kotlin 2.4.21, Compose BOM
  2026.11.01); the daemon is on node-pty 1.1.0.

### Added
- Instrumented Android tests for pairing, TLS pinning, the five main screens,
  LinkService and AppLock, with an emulator CI job for API 30 and 37.
- Token rotation on pairing and on revoke: a superseded token closes 4003 on
  its next message.
- `docs/RUNBOOK.md`, the ADR set, and the CONTRIBUTING pre-push gate.

### Changed
- No `exec` with interpolated strings and no `shell: true` outside `scripts/`;
  both are guard tests in the daemon suite.
- README, `CONTEXT.md` and the feature matrix describe the tree that exists,
  and the daemon protocol table is generated from the handler registry.
