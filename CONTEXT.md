# PocketDesk — Session Context

Date: 2026-09-22 (state section refreshed; original notes 2026-08-24). Repo:
`C:\Users\yasha\PROJECTS\PROJECTS\PocketDesk`.

## What the project is

Android app + Node daemon to drive AI coding agents (and now IDEs/tools) installed on a
Windows PC from a phone. Daemon spawns CLIs in real PTYs (node-pty/ConPTY), serves a WS
API (ws:// or wss:// with self-signed TLS), phone is Kotlin+Compose with xterm.js terminal,
chat UI (in progress), file transfer, multi-PC server list, QR pairing (in progress).

User's north star: **AnyDesk-style**. PC side = install once, hands-free forever.
Phone side = just prompts, attach files, configure stuff. Latest ask adds:
access ALL IDEs, invoke them from cmd, install them from mobile, and use any IDE from
mobile "with all features enabled" → plan is `launch` adapter for GUI apps + VS Code
`code tunnel` adapter so full VS Code opens in the phone browser.

## Layout

- `daemon/src/` — index.js, config.js, server.js, registry.js, sessions.js, chat.js
- `daemon/scripts/` — gen-cert.js, install-service.ps1, uninstall-service.ps1, tray/PocketDeskTray.cs
- `daemon/public/` — index.html (browser test client), pair.html (QR pairing page), vendor/qrcode.min.js (qrcode-generator@1.4.4, works as browser global `qrcode`)
- `daemon/manifests/*.json` — claude, opencode, codex, gemini, aider, qwen (+chat sections)
- `daemon/test/smoke.mjs` + `test/smoke-chat.mjs` — run via `npm.cmd test` (npm.ps1 blocked by execution policy; use npm.cmd)
- `app/` — Android project. Gradle wrapper 9.3.1, AGP 8.13.1, Kotlin 2.1.20, compileSdk 36.
  Keystore: `app/pocketdesk.keystore`, creds in `app/keystore.properties` (both gitignored).
- APKs land in `app/app/build/outputs/apk/{debug,release}/`.

## Protocol summary

hello{token} auth (4003 on bad). Terminal sessions: create/attach/detach/in/resize/kill,
replay scrollback. FS: fs{path} → items[{name,dir,size}], fread/fwrite chunked 256KB base64
(stop-and-wait). Chat (new): chatsession{harness,cwd,prompt} → created{id kind:"chat"},
server attaches socket FIRST then sends prompt (ordering matters — was a bug),
chatmsg{id,text} follow-ups use manifest resumeArgs fresh process per turn,
chatcancel/kill cancel. Events pushed only to subscribed sockets:
chatuser/chatdelta/chartool/chattoolresult/chatstate/chatreplay.
Formats parsed daemon-side: `claude-stream-json`, `codex-json`, plain `text`.
Pairing: GET /pair is loopback-only, serves pair.html with __RH_PAYLOAD__/__RH_URL__/
__RH_TOKEN__/__RH_FP__ replaced; payload = `pocketdesk://pair#<base64url({u,t,f})>`;
/vendor/* static files served from public/vendor.

Manifest chat section: `"chat": { "args": [...], "format": "...", "resumeArgs": [...] }`;
prompt always via stdin. claude: `-p --output-format stream-json --verbose` +
`--continue` resume; codex: `exec --json -` + `exec resume --last`; opencode/gemini/qwen:
text mode stdin, opencode has `--continue`. aider intentionally terminal-only.

## State at save (IMPORTANT — current)

0. 2026-09-22 pass (current head of this workstream):
   - **Six unused clusters deleted.** `sync_*`, `fleet_*`, `agent_*`, `mux_*`/`tmux_*`,
     `qr_*` and `monitor_*` are gone: seven modules (file_sync_engine, fleet_view,
     agent_orchestrator, session_multiplexer, tmux_session_manager, qr_session_sharing,
     session_monitor), their server cases and wiring, and ten test files. Each had a
     green test and no caller — no browser screen, no phone screen, nothing inside the
     daemon. `docs/FEATURE-MATRIX.md` and `docs/ABSORPTION-LEDGER.md` record the removal.
   - **Tunnel bind race fixed.** `tunnel_create` answered before the listener was bound,
     so a client could connect to a port that did not exist yet. `createTunnel` now
     resolves on `listening` and rejects on a bind error, and the handler awaits it.
     Deleting the startup work above made the race reproducible on every run.
   - **SSH front end.** Browser client has an SSH tab (profiles with per-connect
     credentials, key generation with the public half shown, known host keys, host-key
     new/changed banner, bastion and sshserver start/stop bound to loopback by default).
     `profile_create` now carries `keyId`, without which key auth was unreachable from
     the wire. `test/ssh-ui.test.mjs` covers exactly the messages the panel sends.
   - **Android catch-up.** New `ui/SshScreen.kt` mirrors the browser SSH tab, reached
     from the Tools screen; the Tools screen gained the Git and Doctor sections it was
     missing. `assembleDebug`, `testDebugUnitTest` and `bundleRelease` are all clean;
     the release AAB is signed (certificate valid to 2054).
   - **Hardware probe.** `daemon/scripts/hw-probe.mjs` drives the real transports
     against a machine you own: SSH connect + key auth, one remote command, an SFTP
     upload/download byte-compared, and an RFB handshake reporting the announced
     geometry. Still unrun against real hardware — that needs a host only the user has.
   - `npm.cmd test` = **24 files, all pass**.
1. The inspiration-corpus absorption pass (tracked in `docs/FEATURE-MATRIX.md`) is the
   workstream this grew out of; the ledger stays as the provenance record.
2. Open gaps, honestly: no on-device Android run has ever happened (compile-verified
   only); the WhatsApp pairing QR has never been scanned by a phone; the RFB client has
   never met a real VNC server; SSH and SFTP have never left loopback. `hw-probe.mjs`
   closes the last three the moment someone runs it against real hosts.
3. Remaining 🗺️ surfaces: full WebRTC screen transport (frames are JPEG over the
   protocol at ~3 fps), mosh-style UDP roam, E2EE shares, Android foreground service
   and biometric lock.

## Environment facts

- ANDROID_HOME set, SDK platforms 36/37, JDK17 at Eclipse Adoptium, node v24.
- No gradle on PATH; wrapper generated from local dist (9.3.1).
- openssl only via Git (`C:\Program Files\Git\usr\bin\openssl.exe`); csc.exe available
  (.NET Framework 4) — used to compile tray app.
- adb not on PATH: `$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe`.
- Build cmd: `cd app; .\gradlew.bat assembleDebug` (~3 min first time).
- Real config lives in `%USERPROFILE%\.pocketdesk\config.json` (TLS enabled, cert at
  ~/.pocketdesk/tls/, fp b6bedeeb...aa14). Smoke tests use env RH_PORT/RH_TOKEN and no
  longer pollute it (config.js only persists when file absent AND no env overrides).

## Conventions

- Caveman style ONLY in chat + commit subjects; everything persisted to disk is normal prose.
- No comments unless non-obvious constraint; no dead code (user explicitly wants lean APK,
  R8 on; xterm + qrcode vendored locally, no CDN).
- Never commit without being asked; never add AI attribution.
