# PocketDesk — context for a fresh session

Refreshed 2026-11-24 from the tree itself. Every path, count and version below was
read out of the repository on that date; if one of them disagrees with the code,
the code is right and this file needs the fix.

## What it is

A Node daemon on a Windows PC plus an Android app (and a browser UI) that drive AI
coding agents and desktop tools on that PC from a phone. The daemon runs CLIs in
real PTYs (`node-pty`/ConPTY) and serves a WebSocket API on the LAN or over iroh;
the phone is Kotlin + Compose with an xterm.js terminal, chat, file transfer, a
multi-PC list and QR pairing.

Product intent, ethics and the rules we will not break: [docs/INTEGRITY.md](docs/INTEGRITY.md).
What each feature actually does today: [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md).

## Layout (counts as of the refresh)

| Path | What lives there |
|---|---|
| `daemon/src/` | 65 modules at the top level (plus `handlers/`, `plugins/`, `phone_adb/`). Entry point `index.js`; `daemon.js` boots the process; `server.js` is the WS/HTTP surface; `sessions.js` owns PTYs; `cli.js` is the `pocketdesk` command |
| `daemon/src/handlers/` | 13 message modules: agents, computers, display, files, kvm, pc_pad, phone, phone_adb, phone_sync, remote, sources, ssh, system |
| `daemon/src/plugins/` | 3 plugins (auth, logger, metrics), loaded by `plugins.js` |
| `daemon/manifests/` | 17 CLI/GUI manifests: claude, codex, gemini, opencode, opencode-desktop, qwen, aider, cline, copilot, cursor, windsurf, zed, zcode, antigravity, freebuff-desktop, vscode, shell |
| `daemon/public/` | `index.html` (the hub), `ui/` (core, hub, pages, phone, computers, extras, share, thispc), `vendor/` |
| `daemon/scripts/` | installers (`install-service.ps1`, `uninstall-service.ps1`), launcher and tray sources (`PocketDeskLauncher.cs`, `PocketDeskTray.cs`, `PocketDeskKvm.cs`), `gen-cert.js`, bench scripts, `console/`, `linux/`, `mac/`, `unix/` |
| `daemon/test/` | 57 `*.test.mjs` files plus `helpers.mjs` and `setup.mjs` |
| `app/` | Android project (see versions below) |
| `docs/` | `INTEGRITY.md`, `FEATURE-MATRIX.md`, `SETUP-PC.md`, `REPRODUCIBLE-BUILD.md`, `EXCLUSIVE-FULLSCREEN.md`, `ALPHA-CAPTURE.md`, `RELAY.md`, `CONNECTIVITY-NOTES.md`, `TRANSPORT-BENCH.md` |
| `plan.md` | The work plan and the journal; the source of truth for what is being built |

## Running it

```bash
cd daemon
npm install
npm test                 # node --test --test-global-setup=test/setup.mjs "test/*.test.mjs"
npm start                # the daemon, on port 8765 unless config.json says otherwise
node src/cli.js status   # what is installed, elevated or not, auto-start policy, ports
node src/cli.js stop     # ask it to exit, then clear stray helpers
node src/doctor.js       # environment probes (pty, ffmpeg, ports, task, console endpoint)
```

Two environment-driven modes matter:

- `RH_PORT` + `RH_TOKEN` + `RH_HOME` + `POCKETDESK_DATA` make a throwaway instance
  with no TLS and no iroh — this is what every test uses (`test/helpers.mjs`).
- A normal run reads `%USERPROFILE%\.pocketdesk\config.json`.

Ports in use: 8765 (daemon, configurable), the loopback page the phone opens for pairing is
the daemon port + 10 (8775 by default),
8766 (optional SYSTEM console endpoint),
4679 or `RH_CLI_PORT` (loopback CLI server for `pocketdesk pair|record|list`).

Install and uninstall on a real PC: [docs/SETUP-PC.md](docs/SETUP-PC.md). The
installer is `install.ps1`, the uninstaller `uninstall.ps1`; both are covered by
`daemon/test/installer.unit.test.mjs`.

## Android build

Versions are pinned in `app/gradle/libs.versions.toml` and may not carry an
un-noted pre-release (enforced by `daemon/test/prerelease-pins.test.mjs`):

- AGP 9.5.2, Kotlin 2.4.21, Compose BOM 2026.11.01 (Compose 1.13, Material3 1.5.0)
- `compileSdk 37.2`, `targetSdk 37`, `minSdk 30`, `versionName 0.11.0`, `versionCode 26`
- Gradle wrapper 9.8.1, JDK 17 or newer to build (21 was used), NDK ABI: `arm64-v8a` (release) + `x86_64` (debug)
- Signing needs `app/keystore.properties`, which is gitignored; without it the
  release APK is unsigned but still builds.

```bash
cd app
JAVA_HOME=/path/to/jdk21 ./gradlew :app:assembleDebug     # compile + package
JAVA_HOME=/path/to/jdk21 ./gradlew :app:compileDebugKotlin # fastest check that the app still compiles
```

Outputs land in `app/app/build/outputs/apk/{debug,release}/`. Release builds are
reproducible by content, not by file hash: [docs/REPRODUCIBLE-BUILD.md](docs/REPRODUCIBLE-BUILD.md).

## Protocol in one paragraph

`hello{token}` authenticates (close code 4003 on a bad token). Terminal sessions
use create/attach/detach/in/resize/kill with scrollback replay. Files use
`fs{path}` plus chunked `fread`/`fwrite` (256 KB base64). Chat uses
`chatsession{harness,cwd,prompt}` and `chatmsg`, with the socket subscribed before
the prompt is sent; events are `chatuser`, `chatdelta`, `chartool`,
`chattoolresult`, `chatstate`, `chatreplay`. Stream formats parsed daemon-side:
`claude-stream-json`, `codex-json`, plain `text`. Pairing: `GET /pair?k=<token>` is
loopback-only and redirects to `/#go=thispc&t=<token>`, whose page carries
`<meta name="pd-token">` and a `pocketdesk://pair#…` QR payload.

Message names, per handler, are the authority: `daemon/src/handlers/*.js` and
`daemon/test/protocol-contract.test.mjs`. If this paragraph and a handler disagree,
the handler wins.

## Rules that already have a test

- No detection evasion anywhere: `daemon/test/no-evasion.test.mjs` plus a grep gate
  in [CONTRIBUTING.md](CONTRIBUTING.md).
- No un-noted pre-release dependency: `daemon/test/prerelease-pins.test.mjs`.
- The daemon can always be stopped: `daemon/test/stop-cli.test.mjs`,
  `daemon/test/lockdown-client.test.mjs`.
- Every script and installer still parses: the `*.unit.test.mjs` files parse the
  PowerShell and compile the C# with `csc`.
