# PocketDesk — Session Context

Date: 2026-09-08 (state section refreshed; original notes 2026-08-24). Repo:
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

0. 2026-09-10 absorption sweep (this workstream's current head): every one of the 241
   corpus repos is processed, then **rechecked one-by-one** (README + feature lists
   re-investigated per repo; repos renamed back from `done_<repo>` as they cleared).
   The recheck added chat forking, BYOK env profiles, plan mode, attention-first
   session ordering, Mattermost push, and fixed a latent `_execSync` crash in the
   mux_* protocol surface. All repos are accounted for in `docs/ABSORPTION-LEDGER.md` (per-repo
   rows: absorbed ✅ / already-covered ⚙️ / module-present 🧩 / reference-only ➖).
   New daemon modules wired this pass: prompt_queue (queued follow-ups, auto-drain),
   agent_todos (todo boards, markdown-derived), scheduler (interval/once/count jobs,
   persisted), mentions (@file expansion in prompts), doctor (self-diagnosis),
   wake_on_lan, approval_guard (run-level auto-deny, RH_APPROVAL_TIMEOUT_MS),
   mcp_server (embedded MCP endpoint, RH_MCP_PORT), live_digest (digest_attach row
   diffs), stats_usage (usage_list/usage_get from stream usage fields).
   App side: ReconnectPolicy (exp backoff + jitter) + WsClient auto-reconnect and
   since-reattach — the last 🧩 row is now ✅. `npm.cmd test` = 22 files / 202 checks
   ALL PASS (absorb.test.mjs added; features.test.mjs quiet test made deterministic
   via RH_QUIET_MS=3000 and its broken imports/summary fixed). `assembleDebug` builds
   clean (fixed pre-existing Chat-icon + TunnelManager errors too). Corpus repos are
   being renamed done_<repo> after processing.
1. The inspiration-corpus absorption pass (tracked in `docs/FEATURE-MATRIX.md`) is the
   active workstream. 2026-09-08 slices (all wired, tested, matrix-updated): relay link,
   tmux session manager (graceful gate), terminal digest render, agent orchestrator
   (`agent_*`), LAN file transfer (LocalSend v2, byte-verified e2e), file sync engine
   (TS→ESM), stream JSON parser (TS→ESM), QR session sharing (phone connects directly
   to a relay port with `?token=`), session monitor (real process discovery + crash
   history), shooter notifications (coalescing/dedupe/telemetry — two latent bugs
   fixed), fleet view (TS→ESM, agent states project into the grid), session
   multiplexer (tmux gate), remote desktop bridge (TS→ESM), WhatsApp channel surface
   (TS→ESM + fixed unreachable `ready` state; e2e drives a real REPL from an
   allowlisted number).2. **`npm.cmd test` is ALL PASS ×3** (now 22 test files incl. absorb.test.mjs) — the
   whole uncommitted batch is green, uncommitted on master for review. Modules ported from CJS/TS-in-.js to
   working ESM this pass: relay_server, terminal_renderer, file_sync_engine,
   stream_json_parser, session_monitor, shooter_notifications, fleet_view,
   remote_desktop_bridge, whatsapp_bridge.
3. TODO next (matrix): all 🧩 rows are ✅ now; remaining 🗺️ surfaces: full WebRTC
   screen transport (rd_* currently simulates frames), real baileys WhatsApp transport
   (wa_* is the daemon-side channel surface), mosh-style UDP roam, E2EE shares,
   Android foreground service + biometric lock.

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
