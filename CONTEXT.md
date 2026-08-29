# PocketDesk — Session Context

Date: 2026-08-24. Repo: `C:\Users\yasha\Desktop\PROJECTS\PocketDesk` (git initialized, 6 commits on master).

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

## State at save (IMPORTANT — mid-task)

1. Just exported `sendUserMessage` in chat.js (was unexported → TypeError in smoke-chat).
   **Not yet re-run**: `npm.cmd test` must go ALL PASS ×2 before commit. Commit pending for:
   chat engine, manifests chat configs, smoke-chat.mjs, /pair page + static /vendor serving,
   buildPairPage wiring in server.listen.
2. TODO next (user-approved scope): `launch` adapter in registry/server (GUI apps open on
   PC screen) + VS Code tunnel adapter (`code tunnel`, parse URL from stdout, broadcast
   {type:"tunnel",id,url}) + vscode.json manifest + ToolsScreen Launch/Open buttons;
   App: WsClient transcript state + RhEvent additions, ChatScreen UI, nav tabs
   Chats(default)/Terminals/Tools, zxing-embedded QR scan + pocketdesk:// deep link
   intent-filter, attachments→`.rh-uploads/<name>` mention in prompt; root one-shot
   `install.ps1` (npm install → setup-tls → install-service → start → open /pair);
   README update.

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
