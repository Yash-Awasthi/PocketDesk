# 🔧 PocketDesk

> **Run AI coding agents on your PC, control them from your phone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-≥20-brightgreen.svg)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/Protocol-WebSocket-orange.svg)](#protocol-v1)
[![Android](https://img.shields.io/badge/Android-Kotlin-purple.svg)](https://developer.android.com)
[![Plugins](https://img.shields.io/badge/Plugins-4-blueviolet.svg)](#plugin-system)
[![Tests](https://img.shields.io/badge/Tests-8+-brightgreen.svg)](#testing)

**No cloud. No accounts. Your machine, your data, your agents.**

PocketDesk is a self-hosted bridge between your Windows/Linux/Mac PC and your Android phone. Install AI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, or any CLI) on your PC, and drive them from a sleek mobile app over WebSocket — with live terminal streaming, file transfer, AI chat, and a **proposal/approval system** for agent safety.

---

## 📸 Screenshots

> _Add your own screenshots here — terminal streaming, chat interface, plugin dashboard_

| Terminal | Chat | Dashboard |
|----------|------|-----------|
| Live PTY streaming | AI conversations with streaming | Real-time stats & activity |

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🖥️ **Live Terminal** | Real-time PTY streaming with extra keys (Esc, Tab, Ctrl+C/D/Z, arrows) |
| 💬 **AI Chat** | ChatGPT-style conversation with streaming responses and tool indicators |
| 📊 **Dashboard** | Real-time stats, activity timeline, plugin status, connected clients |
| 📁 **File Browser** | Browse, upload, and download files on your PC from your phone |
| 🔐 **TLS + Pinning** | Self-signed cert support with SHA-256 fingerprint pinning |
| 📦 **Auto-Install** | One-tap npm/pip install with live progress output |
| 🔌 **Plugin System** | Drop a JS file to extend the daemon — no core changes needed |
| 📝 **Proposals** | Agent actions require human approval — safety by default |
| 📱 **Multi-PC** | Connect to multiple PCs, each with pinned certificates |
| 🔔 **Background Notify** | Get notified when sessions end while the app is in background |

---

## ⚡ Quick Install

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/main/install.ps1 | iex
```

**Manual:**
```bash
git clone https://github.com/Yash-Awasthi/PocketDesk.git
cd PocketDesk/daemon
npm install
npm start
```

---

## 🏗️ Architecture

```
┌──────────────┐          WebSocket (JSON)         ┌──────────────────┐
│              │ ◄────────────────────────────────► │                  │
│  Android App │          LAN / Tailscale           │  harnessd        │
│  (Kotlin)    │                                    │  (Node.js)      │
│              │                                    │                  │
│  ┌────────┐  │                                    │  ┌────────────┐  │
│  │Terminal│  │                                    │  │  Sessions  │  │
│  │ Screen │  │                                    │  │  (PTY)     │  │
│  ├────────┤  │                                    │  ├────────────┤  │
│  │ Chat   │  │         propose → approve           │  │  Chat      │  │
│  │ Screen │  │                                    │  │  (Streaming│  │
│  ├────────┤  │                                    │  ├────────────┤  │
│  │ Dash-  │  │                                    │  │  Plugins   │  │
│  │ board  │  │                                    │  │  (Hooks)   │  │
│  └────────┘  │                                    │  ├────────────┤  │
│              │                                    │  │  Registry  │  │
│              │                                    │  │  (Tools)   │  │
└──────────────┘                                    │  └─────┬──────┘  │
                                                    │        │         │
                                                    │   ConPTY / spawn │
                                                    │        │         │
                                                    │  ┌─────▼──────┐  │
                                                    │  │ claude /    │  │
                                                    │  │ codex /     │  │
                                                    │  │ gemini /    │  │
                                                    │  │ opencode    │  │
                                                    │  └────────────┘  │
                                                    └──────────────────┘
```

Every coding agent is described by a JSON manifest. The daemon scans PATH, reports what's installed, and streams terminal sessions bidirectionally:

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

## 🔌 Plugin System

PocketDesk has a plugin system inspired by deepseek-harness and claude-code-hermit. Plugins extend the daemon with lifecycle hooks — **no core changes needed**.

### Quick Start

Drop a `.js` file in `daemon/src/plugins/`:

```javascript
export default {
  name: "my-plugin",
  version: "1.0.0",
  hooks: ["onMessage", "onConnect"],

  init(ctx) { },          // Called once at startup
  start(ctx) { },         // Called when daemon starts listening
  stop(ctx) { },          // Called on graceful shutdown
  onConnect(ctx, ws) { }, // New WebSocket connection
  onDisconnect(ctx, ws) { }, // WebSocket closed
  onMessage(ctx, ws, msg) { }, // Incoming message
};
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
| `proposal-plugin.js` | Gates sensitive actions through human approval |

### Plugin Context

Plugins receive a `ctx` object:

- `ctx.sessions` — session manager (create, attach, detach, write, kill)
- `ctx.chat` — chat manager (create, attach, send, cancel)
- `ctx.proposals` — proposal manager (create, approve, reject)
- `ctx.broadcast` — send messages to all connected clients
- `ctx.registry` — tool discovery and installation
- `ctx.config` — daemon configuration (port, token, dataDir)

---

## 📝 Proposal System

Inspired by claude-code-hermit's operator-gated proposal pattern:

1. Agent suggests an action (file write, command, network request)
2. Proposal card appears in the web UI
3. User clicks **Approve** or **Reject**
4. Action executes or is blocked

```javascript
// Create a proposal
ctx.proposals.create({
  type: "command_execute",
  summary: "Run npm build",
  detail: { command: "npm run build" },
  sessionId: "abc123",
});

// Wait for decision
const { status } = await ctx.proposals.waitForDecision(proposal.id);
// status: "approved" | "rejected" | "expired"
```

Proposals auto-expire after 5 minutes.

---

## 🆚 Comparison

| | PocketDesk | claude-code-hermit | OpenAI Codex |
|---|---|---|---|
| **Type** | Multi-agent bridge | Claude Code plugin | Local coding agent |
| **Agents** | Any CLI tool | Claude only | Codex only |
| **Mobile App** | ✅ Android (Kotlin) | ❌ | ❌ |
| **Live Terminal** | ✅ Full PTY | ❌ | ❌ |
| **Plugin System** | ✅ JS plugins + hooks | ✅ Extension points | ❌ |
| **Proposal/Approval** | ✅ Built-in | ✅ Operator-gated | ❌ |
| **Dashboard** | ✅ Real-time stats | ❌ | ❌ |
| **AI Chat** | ✅ Streaming | ✅ (Claude native) | ✅ (Codex native) |
| **TLS + Pinning** | ✅ SHA-256 | ❌ | ❌ |
| **Cost** | Free | Free (needs Claude sub) | Free (needs API key) |
| **Language** | Node.js | TypeScript | Rust |

---

## 📖 Protocol (v1)

JSON frames; binary payloads are base64.

**Client → Server:**
`hello` · `detect` · `install` · `create` · `attach` · `detach` · `in` · `resize` · `kill` · `fs` · `fread` · `fwrite` · `chatsession` · `chatmsg` · `chatcancel` · `propose` · `approve` · `reject` · `proposal_list`

**Server → Client:**
`welcome` · `manifests` · `sessions` · `created` · `replay` · `out` · `exit` · `progress` · `fs` · `fchunk` · `fwritten` · `chatreplay` · `chatuser` · `chatdelta` · `chartool` · `chatstate` · `proposal_created` · `proposal_approved` · `proposal_rejected` · `error`

---

## 🧪 Testing

```bash
cd daemon
node test/proposals.test.mjs    # Proposal system (7 tests)
node test/smoke.mjs              # Session smoke tests
```

---

## 📂 Project Structure

```
PocketDesk/
├── daemon/                       # Node.js daemon
│   ├── src/
│   │   ├── server.js             # HTTP + WebSocket server
│   │   ├── sessions.js           # PTY session manager
│   │   ├── chat.js               # AI chat engine (streaming)
│   │   ├── registry.js           # Tool discovery + install
│   │   ├── plugins.js            # Plugin loader + lifecycle
│   │   ├── proposals.js          # Proposal/approval manager
│   │   ├── heartbeat.js          # Session health monitoring
│   │   └── plugins/              # Built-in plugins
│   │       ├── logger-plugin.js
│   │       ├── metrics-plugin.js
│   │       ├── auth-plugin.js
│   │       └── proposal-plugin.js
│   ├── manifests/                # Agent JSON manifests
│   └── test/                     # Tests
├── app/                          # Android app (Kotlin + Compose)
│   └── app/src/main/java/com/yasha/pocketdesk/
│       ├── ui/
│       │   ├── ChatScreen.kt     # AI chat conversation
│       │   ├── TerminalScreen.kt # Live terminal
│       │   ├── SessionsScreen.kt # Session manager
│       │   └── ToolsScreen.kt    # Tool installer
│       ├── WsClient.kt           # WebSocket client
│       ├── Protocol.kt           # Message protocol
│       └── MainActivity.kt       # Navigation
├── install.sh                    # One-liner installer (Linux/Mac)
├── install.ps1                   # One-liner installer (Windows)
└── README.md
```

---

## 🔒 Security

- **Token auth**: Every WebSocket client must present the token as its first message. Wrong token → connection closed (4003).
- **TLS + certificate pinning**: With TLS enabled, the app shows the cert's SHA-256 fingerprint. Confirm once — pinned for all future connects.
- **Proposal system**: Sensitive actions (file writes, commands, network requests) require explicit human approval.
- **Local-only**: Run inside Tailscale or LAN. **Do not** port-forward to the internet — the protocol has full shell control of your PC.

---

## 🗺️ Roadmap

- [ ] Web-based terminal viewer (access from any browser)
- [ ] Screen bridge (WebRTC) for GUI-only apps
- [ ] Provider presets (DeepSeek, Kimi, GLM, OpenRouter)
- [ ] Cross-platform app (iOS / Desktop)
- [ ] OAuth2 plugin for third-party auth
- [ ] Webhook notifications (Discord, Slack, email)

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes
4. Open a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 📄 License

[MIT](LICENSE) — Use it, fork it, ship it.
