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

### Phone-to-PC connectivity

Install [Tailscale](https://tailscale.com) on the PC and the phone. The daemon URL from
the phone is then `ws://<pc-tailnet-name>:8765/ws` — no port forwarding, encrypted by
WireGuard. A plain LAN IP works at home too.

### Android app

1. Open `app/` in Android Studio (it provisions Gradle automatically).
2. Build and install the app.
3. Enter the daemon URL and token on the connect screen.

## Security model

- Every WebSocket client must present the token as its first message; wrong token closes
  the connection with code 4003 before anything else is accepted.
- Run the daemon only inside a trusted network (Tailscale tailnet recommended). Do not
  port-forward it to the public internet: the protocol has full shell control of your PC.

## Protocol (v1)

JSON frames; binary payloads are base64 UTF-8.

Client → server: `hello{token}`, `detect`, `install{id}`, `create{harness,cwd}`,
`attach{id}`, `detach{id}`, `in{id,data}`, `resize{id,cols,rows}`, `kill{id}`, `fs{path}`.

Server → client: `welcome`, `manifests{items}`, `sessions{items}`, `created`,
`replay{id,data}`, `out{id,data}`, `exit{id,code}`, `progress{id,line}`, `fs{...}`,
`error{message}`.

## Roadmap

- Structured adapters: run CLIs in their headless JSON modes
  (`claude -p --output-format stream-json`, `codex exec --json`, OpenCode's HTTP API)
  for a ChatGPT-style chat screen with model/effort pickers, file attachments, and
  approve/deny cards.
- Provider presets: point any CLI at DeepSeek/Kimi/GLM/OpenRouter endpoints.
- Screen bridge (WebRTC) for GUI-only apps such as Antigravity.
