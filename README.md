# 🔧 PocketDesk

> **Run AI coding agents on your PC, control them from your phone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-≥20-green.svg)](https://nodejs.org)
[![Android](https://img.shields.io/badge/Android-Kotlin-orange.svg)](https://developer.android.com)

**PocketDesk** is a self-hosted bridge between your Windows PC and your Android phone. Install AI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, or any CLI) on your PC, and drive them from a sleek mobile app over WebSocket — with live terminal streaming, file transfer, and a brand-new **AI chat interface**.

No cloud. No accounts. Your machine, your data, your agents.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🖥️ **Live Terminal** | Real-time PTY streaming with extra keys (Esc, Tab, Ctrl+C/D/Z, arrows) |
| 💬 **AI Chat** | ChatGPT-style conversation with streaming responses and tool indicators |
| 📁 **File Browser** | Browse, upload, and download files on your PC from your phone |
| 🔐 **TLS + Pinning** | Self-signed cert support with SHA-256 fingerprint pinning |
| 📦 **Auto-Install** | One-tap npm/pip install with live progress output |
| 🔌 **Plugin System** | Drop a JSON manifest to add any CLI tool |
| 📱 **Multi-PC** | Connect to multiple PCs, each with pinned certificates |
| 🔔 **Background Notify** | Get notified when sessions end while the app is in background |

---

## 🏗️ Architecture

```
┌──────────────┐        WebSocket (JSON)        ┌──────────────┐
│              │ ◄─────────────────────────────► │              │
│  Android App │        Tailscale / LAN          │  harnessd    │
│  (Kotlin)    │                                 │  (Node.js)   │
│              │                                 │              │
└──────────────┘                                 └──────┬───────┘
                                                        │
                                                  ConPTY / spawn
                                                        │
                                              ┌─────────▼─────────┐
                                              │  claude / codex /  │
                                              │  gemini / opencode │
                                              └───────────────────┘
```

Every coding agent is described by a JSON manifest. The daemon scans PATH, reports what's installed, and streams terminal sessions bidirectionally. Add a new agent by dropping one file:

```json
{
  "id": "kimi",
  "name": "Kimi Code",
  "adapter": "terminal",
  "bin": "kimi",
  "install": { "npm": "@moonshot-ai/kimi" }
}
```

---

## 🚀 Quick Start

### 1. Start the daemon (PC)

```powershell
cd daemon
npm install
npm start
```

The console prints the WebSocket URL and auth token. A browser test client is available at `http://localhost:8765`.

### 2. Install the app (Phone)

Build the APK:

```powershell
cd app
.\gradlew.bat assembleDebug
```

Or open `app/` in Android Studio and press Run.

### 3. Connect

On the phone: tap **+** → enter the PC's WebSocket URL and token → done.

---

## 🔌 Plugin System

PocketDesk has a plugin system inspired by deepseek-harness (everything-is-a-plugin) and claude-code-hermit (extension hooks). Plugins extend the daemon with lifecycle hooks — no core changes needed.

### Plugin Format

Drop a `.js` file in `daemon/src/plugins/`:

```javascript
export default {
  name: "my-plugin",
  version: "1.0.0",
  hooks: ["onMessage", "onConnect"],
  init(ctx) { },       // called once at startup
  start(ctx) { },      // called when daemon starts
  stop(ctx) { },       // called on shutdown
  onConnect(ctx, ws) { },
  onDisconnect(ctx, ws) { },
  onMessage(ctx, ws, msg) { },
}
```

### Hook Return Values

| Return | Effect |
|--------|--------|
| `undefined` | Continue processing normally |
| `{ block: true }` | Prevent message from reaching the handler |
| `{ modify: {...} }` | Replace the message before handling |

### Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `logger-plugin.js` | Logs all WebSocket events with timestamps |
| `metrics-plugin.js` | Collects session metrics (message count, uptime) |
| `auth-plugin.js` | Optional token-based auth (replaces built-in) |

### Plugin Context

Plugins receive a `ctx` object with access to:

- `ctx.sessions` — session manager (create, attach, detach, write, kill)
- `ctx.chat` — chat manager (create, attach, send, cancel)
- `ctx.broadcast` — send messages to all connected clients
- `ctx.registry` — tool discovery and installation
- `ctx.config` — daemon configuration (port, token, dataDir)

---

## 🔒 Security

- **Token auth**: Every WebSocket client must present the token as its first message. Wrong token → connection closed (4003).
- **TLS + certificate pinning**: With TLS enabled, the app shows the cert's SHA-256 fingerprint. Confirm once — pinned for all future connects.
- **Local-only**: Run inside Tailscale or LAN. Do not port-forward to the internet — the protocol has full shell control of your PC.

---

## 📖 Protocol (v1)

JSON frames; binary payloads are base64.

**Client → Server:** `hello`, `detect`, `install`, `create`, `attach`, `detach`, `in`, `resize`, `kill`, `fs`, `fread`, `fwrite`, `chatsession`, `chatmsg`, `chatcancel`

**Server → Client:** `welcome`, `manifests`, `sessions`, `created`, `replay`, `out`, `exit`, `progress`, `fs`, `fchunk`, `fwritten`, `chatreplay`, `chatuser`, `chatdelta`, `chartool`, `chatstate`, `error`

---

## 🧪 Testing

```powershell
cd daemon
npm test          # smoke tests (sessions + chat engine)
```

---

## 📂 Project Structure

```
PocketDesk/
├── daemon/                    # Node.js daemon
│   ├── src/
│   │   ├── server.js          # HTTP + WebSocket server
│   │   ├── sessions.js        # PTY session manager
│   │   ├── chat.js            # AI chat engine (streaming)
│   │   ├── registry.js        # Tool discovery + install
│   │   └── tls.js             # TLS + certificate pinning
│   ├── manifests/             # Agent JSON manifests
│   └── test/                  # Smoke tests
├── app/                       # Android app (Kotlin + Compose)
│   └── app/src/main/java/com/yasha/pocketdesk/
│       ├── ui/
│       │   ├── ChatScreen.kt      # AI chat conversation
│       │   ├── TerminalScreen.kt   # Live terminal
│       │   ├── SessionsScreen.kt   # Session manager
│       │   ├── ToolsScreen.kt     # Tool installer
│       │   └── ConnectScreen.kt   # Server connection
│       ├── WsClient.kt            # WebSocket client
│       ├── Protocol.kt            # Message protocol
│       └── MainActivity.kt        # Navigation
└── README.md
```

---

## 🗺️ Roadmap

- [ ] Web-based terminal viewer (access from any browser)
- [ ] Screen bridge (WebRTC) for GUI-only apps
- [ ] Provider presets (DeepSeek, Kimi, GLM, OpenRouter)
- [ ] Cross-platform app (iOS / Desktop)

---

## 🤝 Contributing

Contributions welcome! Open an issue or PR. For major changes, please open an issue first to discuss what you'd like to change.

---

## 📄 License

[MIT](LICENSE)
