# PocketDesk

Run AI coding agents (OpenCode, Claude Code, Codex, Gemini CLI, Qwen Code, Aider, or any
CLI) on your Windows PC and drive them from an Android app, from anywhere. The phone
connects over a WebSocket to a small daemon that spawns each CLI in a real pseudo-terminal
(ConPTY) and streams it live.

## Components

| Folder   | What it is                                                        |
| -------- | ----------------------------------------------------------------- |
| `daemon` | Node.js daemon: tool registry, installs, PTY sessions, WS server  |
| `app`    | Kotlin + Jetpack Compose Android client                           |

## How it works

```
Android app ──WebSocket(JSON)──> harnessd (PC) ──ConPTY──> opencode / claude / codex / ...
             Tailscale mesh between phone and PC
```

Every supported CLI is described by a JSON manifest (`daemon/manifests/*.json`). The
daemon scans PATH, reports what is installed, can install missing tools via npm/pip with
live progress, and streams terminal sessions both ways. Add support for a new CLI by
dropping one manifest file into `%USERPROFILE%\.pocketdesk\manifests\`:

```json
{ "id": "kimi", "name": "Kimi Code", "adapter": "terminal",
  "bin": "kimi", "install": { "npm": "@moonshot-ai/kimi" } }
```

## Setup

### PC (daemon)

```powershell
cd daemon
npm install
npm start
```

The console prints the WebSocket URL and the auth token; the token is stored in
`%USERPROFILE%\.pocketdesk\config.json`. A browser test client is served at
`http://localhost:8765`.

Verify everything with the end-to-end test:

```powershell
npm test
```

### PC (auto-start with tray)

The tray app owns the daemon: green icon means it is running. It starts at logon.

```powershell
cd daemon\scripts
.\install-service.ps1     # compiles the tray app and registers the logon task
.\uninstall-service.ps1   # to remove it again
```

The tray menu can open the web UI and copy pairing info (URL, token, cert fingerprint).

### TLS (wss)

By default the daemon speaks plain `ws://`, which is fine inside a Tailscale tailnet.
To encrypt the last hop yourself (plain LAN, hostile Wi-Fi, port forwarding), generate a
self-signed certificate and restart the daemon:

```powershell
cd daemon
npm run setup-tls
```

The daemon then serves `wss://` on the same port. On first connect the app shows the
certificate's SHA-256 fingerprint; compare it with the value printed by `setup-tls` and
trust it once — it is pinned for that server afterwards. The fingerprint is also written
to `%USERPROFILE%\.pocketdesk\tls\fingerprint.txt`.

### Phone-to-PC connectivity

Install [Tailscale](https://tailscale.com) on the PC and the phone. The daemon URL from
the phone is then `ws://<pc-tailnet-name>:8765/ws` — no port forwarding, encrypted by
WireGuard. A plain LAN IP works at home too.

### Android app

Build an APK from the command line (a wrapper is included; JDK 17 required):

```powershell
cd app
.\gradlew.bat assembleDebug          # debug build for testing
.\gradlew.bat assembleRelease        # signed release build (needs keystore.properties)
```

For release signing, create `app\keystore.properties` with `storeFile`, `storePassword`,
`keyAlias`, `keyPassword` pointing at a keystore you keep private. Without that file the
release build is simply unsigned.

Then either install the APK on the phone, or open `app/` in Android Studio and press Run.
On the connect screen tap **+** to add a PC (name, `ws://`/`wss://` URL, token); saved
PCs are listed and reconnectable.

## App features

- Multi-PC server list with per-server pinned certificates
- Tool detection and one-tap installs with live npm/pip output
- Multiple concurrent PTY sessions with scrollback replay after reconnect
- Extra keys row (Esc, Tab, Ctrl+C/D/Z, arrows, Home/End, PgUp/PgDn, shell punctuation)
- File browsing on the PC, downloads into the phone's Downloads, uploads via the system picker
- Notifications when a session ends while the app is in the background

## Security model

- Every WebSocket client must present the token as its first message; wrong token closes
  the connection with code 4003 before anything else is accepted.
- With TLS enabled the app refuses to send the token until you confirm the certificate
  fingerprint; the pin is checked on every later connect.
- Run the daemon only inside a trusted network (Tailscale tailnet recommended). Do not
  port-forward it to the public internet: the protocol has full shell control of your PC.

## Protocol (v1)

JSON frames; binary payloads are base64.

Client → server: `hello{token}`, `detect`, `install{id}`, `create{harness,cwd}`,
`attach{id}`, `detach{id}`, `in{id,data}`, `resize{id,cols,rows}`, `kill{id}`, `fs{path}`,
`fread{path,offset}`, `fwrite{path,data,append}`.

Server → client: `welcome`, `manifests{items}`, `sessions{items}`, `created`,
`replay{id,data}`, `out{id,data}`, `exit{id,code}`, `progress{id,line}`, `fs{...}`,
`fchunk{path,offset,size,data,eof}`, `fwritten{path,size}`, `error{message}`.

## Roadmap

- Structured adapters: run CLIs in their headless JSON modes
  (`claude -p --output-format stream-json`, `codex exec --json`, OpenCode's HTTP API)
  for a ChatGPT-style chat screen with model/effort pickers, file attachments, and
  approve/deny cards.
- Provider presets: point any CLI at DeepSeek/Kimi/GLM/OpenRouter endpoints.
- Screen bridge (WebRTC) for GUI-only apps such as Antigravity.
