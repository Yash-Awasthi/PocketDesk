# 🔧 PocketDesk

> **Run AI coding agents on your PC, control them from your phone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-≥20-brightgreen.svg)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/Protocol-WebSocket-orange.svg)](#protocol-v1)
[![Android](https://img.shields.io/badge/Android-Kotlin-purple.svg)](https://developer.android.com)
[![Plugins](https://img.shields.io/badge/Plugins-4-blueviolet.svg)](#plugin-system)
[![Tests](https://img.shields.io/badge/Tests-24%20suites-brightgreen.svg)](#testing)

**No cloud. No accounts. Your machine, your data, your agents.**

PocketDesk is a self-hosted bridge between your Windows/Linux/Mac PC and your Android phone. Install AI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, or any CLI) on your PC, and drive them from a sleek mobile app over WebSocket — with live terminal streaming, file transfer, AI chat, and a **proposal/approval system** for agent safety.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🖥️ **Live Terminal** | Real-time PTY streaming with extra keys (Esc, Tab, Ctrl+C/D/Z, arrows) — seq-numbered output with missed-output backfill after reconnect |
| 💬 **AI Chat** | ChatGPT-style conversation with streaming responses and tool indicators |
| 📊 **Dashboard** | Real-time stats, activity timeline, plugin status, connected clients |
| 📁 **File Browser** | Browse, upload, and download files on your PC from your phone |
| 🔐 **TLS + Pinning** | Self-signed cert support with SHA-256 fingerprint pinning |
| 📦 **Auto-Install** | One-tap npm/pip install with live progress output |
| 🪟 **IDE Launch** | Open any installed desktop IDE or GUI app on the PC from the phone, at the project folder you picked — the window opens on the PC, then the Desktop screen drives it (`gui_open`) |
| 🔎 **App discovery** | Everything installed, not only what ships a manifest: Start Menu shortcuts, `/Applications` bundles and `.desktop` entries for GUI apps, PATH for command-line tools. Search on the Tools screen, **Open** for a GUI app, **Run** for a CLI tool in a PTY (`apps_discover`) |
| 🔌 **Plugin System** | Drop a JS file to extend the daemon — no core changes needed |
| 📝 **Proposals** | Agent actions require human approval — safety by default |
| 📱 **Multi-PC** | Connect to multiple PCs, each with pinned certificates |
| 🔔 **Background Notify** | Get notified when sessions end while the app is in background |
| 👥 **Session Sharing** | Read-only spectator links with TTL — phone, browser, second PC watch one session |
| 🎬 **Session Recording** | Record any session and replay/export it later |
| 📈 **Activity Monitor** | Per-session working/asking/quiet states with busy→quiet push |
| 🔀 **Tunnels** | Reach any PC-local service from your phone over the harness connection |
| 🖥️ **VNC Bridge** | Serve the live captured screen over a local TCP port — clients ask for `GET_FRAME` and get real JPEG frames (`vnc_start/stop/status/frame` + `vnc_event`) |
| 🖨️ **Desktop Control** | Watch the whole PC screen live (~3 fps) and drive it — from the **browser AND the Android app** (tap = click, long-press = right-click, drag = move, scroll, type, keys) (`desktop_*`; Windows, PowerShell-powered). The session-scoped `rd_*` surface serves the same capture and input per viewer. |
| 🔔 **Push Test** | One click in the browser fires a test push through every configured channel — verify your ntfy/Pushover phone subscription instantly |
| 🛡️ **SSH Bastion** | A real jump host: log in as `user@host` with your registered key, the access rule is checked, and the channel is proxied to the target with byte accounting (`bastion_*`) |
| 🔒 **SSH Server Control** | A real SSH listener on the PC: per-user password/public-key auth, command allowlists enforced before a command runs, PTY shells, session recording (`sshserver_*`) |
| 📇 **Connection Profiles** | Real SSH, SFTP and VNC connections from saved profiles, host-key trust-on-first-use, OpenSSH key generation kept out of the protocol (`profile_*`/`hostkey_*`/`sshkey_*`) |
| 🔐 **SSH Screen** | Profiles, key generation, known host keys and start/stop for both PC-side listeners — on the browser client's SSH tab and on the phone, reached from the Tools screen |
| ⚡ **Keep-Awake** | PC stays awake while agents run (per-process, never touches your power settings) |
| 🤖 **Telegram Control** | Prompt sessions and approve proposals from a Telegram chat |
| 💚 **WhatsApp Control** | Link the daemon as a WhatsApp companion device (real pairing QR), then drive sessions with prefixed messages from allowlisted numbers (`wa_*`) |
| ♻️ **Chat Resurrection** | Conversations survive daemon restarts — one tap re-opens them via the CLI's own history |
| 🌿 **Git Panel** | Branch/diff/log/status of any repo on the PC, read-only |
| ⏭️ **Prompt Queue** | Queue follow-ups while the agent works — they drain automatically when the turn finishes |
| ✅ **Todo Boards** | Live task lists per session — auto-derived from the agent's markdown checkboxes |
| ⏰ **Scheduler** | Auto-continue loops: fire a prompt on an interval, after a delay, or N times |
| 📣 **@file Mentions** | Reference PC-side files in prompts — content is inlined before the agent sees it |
| 🩺 **Doctor** | One message returns a full self-diagnosis of the daemon and its agents |
| 🌁 **Wake-on-LAN** | Magic-packet wake of a sleeping PC from the phone |
| ⏱️ **Approval Auto-Deny** | Unattended agents never stall — unanswered approvals are auto-denied on a timer |
| 💰 **Usage Dashboard** | Per-session token + cost aggregates straight from the agent's stream events |
| 📉 **Live Digest** | Attach to a terminal as diffed plain-text rows instead of raw bytes |
| 🔌 **MCP Endpoint** | Any MCP client on the PC can drive the agents (`tools/list`, `tools/call`) |
| 📶 **Auto-Reconnect** | The app reconnects with exponential backoff + jitter and replays only missed output |

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

Runtime dependencies are `ws`, `node-pty` and `ssh2` (the SSH server, jump host
and connection profiles). WhatsApp control additionally needs
`@whiskeysockets/baileys`, which is an optional dependency: skip it and every
other feature still runs — only a WhatsApp channel will refuse to link.

---

## 📱 Connect your phone (complete guide)

The Android app is the primary remote: chats, live terminals, the agent fleet,
the Freebuff control plane, files, models and **full desktop control** — every
daemon feature is reachable from it.

### Step 1 — Get the app on your phone

Pick one:

- **Download the APK from CI** (easiest): open the repo's
  [Actions tab](https://github.com/Yash-Awasthi/PocketDesk/actions) → click
  the latest green run → download the **PocketDesk-debug-apk** artifact →
  unzip → copy `app-debug.apk` to your phone and install it
  (allow "install unknown apps" when asked).
- **Build it yourself**: `cd app && ./gradlew assembleDebug` → APK at
  `app/app/build/outputs/apk/debug/app-debug.apk`.

### Step 2 — Start the daemon on the PC

```bash
cd PocketDesk/daemon
npm start
```

The banner prints everything: the pairing URL, the WebSocket URL and the full
auth token (also persisted to `~/.pocketdesk/config.json` —
`%USERPROFILE%\.pocketdesk\config.json` on Windows).

### Step 3 — Pair

1. **QR pairing (easiest)** — on the PC, open `http://localhost:8765/pair` and
   scan the QR **with the PocketDesk app** (tap **＋ → Scan QR**). The app
   receives the URL, token and (with TLS) the cert fingerprint automatically.
   > Note: the QR page is loopback-only by design — open it on the PC itself,
   not on the phone.
2. **Manual entry** — in the app tap **＋**, then enter
   `ws://<pc-ip>:8765/ws` (find the PC's IP with `ipconfig` / `ip a`) and the
   token from the banner or `config.json`.
3. **Browser smoke test** — open `http://localhost:8765` on the PC, paste the
   token, hit **Connect**, then **＋ New Chat** → pick an installed agent →
   prompt → **Start**. The browser client also carries a **Tools** tab:
   a read-only Git panel for any repo path on the PC, the `doctor` self-check,
   and a search over everything installed with **Open** for a GUI app or
   **Run** for a command-line tool.

When the app's status bar shows **Connected**, you're paired.

### Step 4 — Control everything

| App screen | What you can do |
|---|---|
| **Tools** | See every managed agent CLI (Claude Code, Codex, OpenCode, Antigravity, Copilot, Cline, ZCode, Gemini, Qwen, Aider) — install/uninstall, versions — plus the desktop IDEs found on the PC, each with an **Open** button |
| **Sessions** | Live PTY terminals of any session — full keyboard streaming, like SSH |
| **Chats** | Create agent chats, stream replies token-by-token, pick the **model** (opus/sonnet/haiku…) per chat, cancel a running turn |
| **Desktop** | AnyDesk-style view of the whole PC screen (~3 fps): tap = move+click, long-press = right-click, drag = move, two-finger/▲▼ = scroll, type into any window |
| **Freebuff** | The Freebuff desktop app itself: open/quit, login state and **logout**, browse & run all skills, view & edit allowlisted configs (each edit backed up) |

Install agents from the phone too: any tool card marked "not installed" has an
**Install** button (one-tap npm/pip install with live progress).

**First terminal session in a new folder:** Claude Code opens with a workspace
trust prompt whose default option is *No, exit* — pressing Enter straight away
quits it. Use the **↓** key in the terminal key row to select *Yes, I trust this
folder*, then Enter. After that the REPL appears and typing works normally.

### 🦾 Controlling Freebuff itself from the phone

The Freebuff tab (browser) / Freebuff screen (app) gives full control of the
Freebuff desktop app on the PC: app status (running/exe/profile), **open &
quit**, login state and **logout**, all **28 skills** in `~/.claude/skills`
(view SKILL.md or run a skill as a real agent chat), and allowlisted
**config files** with view/edit (every edit is backed up as `.bak`).

### 🤖 Agent fleet & model selection

Beyond Claude Code, Codex and OpenCode the daemon manages **GitHub Copilot
CLI, Cline, ZCode, Gemini, Qwen and Aider** — install and launch any of them
from the phone. Chats support **model selection** where the CLI offers it
(e.g. Claude: opus / sonnet / haiku) via the model picker in the chat toolbar;
the choice drives the agent's runtime flags.

### 🪟 Desktop IDEs

Some of these agents ship as desktop applications rather than CLIs. The daemon
finds the ones installed on the PC and the Tools screen offers **Open** for
each: **VS Code, Zed, Antigravity, OpenCode Desktop** and **Freebuff Desktop**.
There is no PTY behind them, so opening starts the window on the PC and the
**Desktop** screen is how you see and drive it from the phone.

---

## 📖 Operations Manual

### Starting the daemon

```bash
cd PocketDesk/daemon
npm start          # first run generates + persists the token
```

The banner prints everything: local URL, WebSocket URL, the full auth token
(dev only), the pairing-QR URL, and (if configured) the relay line. Everything
also persists to `~/.pocketdesk/config.json`:

```json
{
  "port": 8765,
  "token": "<your-token>",
  "relay": { "url": "", "channel": "", "hostPort": 8790 }
}
```

Environment overrides (win each over the config file): `RH_PORT`, `RH_TOKEN`,
`RH_RELAY_URL`, `RH_RELAY_CHANNEL`, `RH_RELAY_PORT`. TLS: `node scripts/gen-cert.js`
then set `tls.enabled: true` in the config.

Keep it running after logout with PM2 (`npm i -g pm2 && pm2 start src/index.js --name pocketdesk && pm2 save`)
or NSSM on Windows.

### How access works — three ways to reach your PC

The phone never touches your PC directly unless it's on the same network.
Authentication is always the same: the app sends the token once at connect
(`hello`), and every command thereafter is authenticated by that socket.

| Mode | Phone URL | When to use | PC needs |
|---|---|---|---|
| **LAN** | `ws://<pc-ip>:8765/ws` | Phone on same Wi-Fi | Nothing special |
| **Relay** | `relay://<relay-host>:8790/<channel>` | Any network — kilometers away, mobile data, hotel Wi-Fi | Outbound internet only |
| **Tailscale/VPN** | `ws://<tailscale-ip>:8765/ws` | You manage a tailnet | Tailscale on both ends |
| **Port-forward** | `wss://your.domain:8765/ws` (TLS!) | You control the router | Forwarded port + TLS cert |

**LAN (same Wi-Fi) — default.** Start the daemon, scan the QR at
`http://localhost:8765/pair`, done.

**Kilometers away — the relay (no VPN, no port forwarding).** The daemon dials
OUT to a relay server and subscribes to a channel; your phone dials the same
relay and publishes protocol requests on that channel. No inbound port on the
PC, works through NAT/carrier-grade NAT/firewalls on both ends:

```bash
# On the PC — host a relay AND link to it in one go:
RH_RELAY_PORT=8790 npm start
# banner now shows:  relay  hosting :8790  (phone URL: relay://<this-pc>:8790/rh-<hostname>)
```

In the app add a server with URL `relay://<pc-public-ip-or-ddns>:8790/rh-<hostname>`
and the same token.

But wait — if the PC must be reachable on 8790, isn't that port forwarding?
Only in the hosting case, which is a convenience for LAN peers. The fully
remote-proof setup needs **no inbound port at all**: run the tiny relay
*anywhere else* — a $4 VPS, a home NAS, any always-on box — and point **both**
ends at it:

```bash
# On the VPS (any Node 18+ box):
npx pocketdesk-relay --port 8790        # or: git clone … && node daemon/src/relay_server.js

# On the PC — dial OUT to it (persist by putting it in config.json "relay": {"url": ...}):
RH_RELAY_URL=relay://vps.example.com:8790 RH_RELAY_CHANNEL=rh-my-laptop npm start

# On the phone, any network on earth:
#   URL:   relay://vps.example.com:8790/rh-my-laptop
#   Token: same as the PC's
```

Both ends keep an **outbound** TCP connection to the relay; the relay just
shuttles framed JSON between members of a channel. The token still guards every
command (the relay bridge validates it with the same timing-safe check as the
WebSocket handshake — a wrong token gets nothing), and TLS is available end to
end (`wss` pair page / pinned cert in the app) if you terminate it on the relay
host.

What works over the relay: everything the protocol does — sessions, terminal
streaming, chats with live deltas, Freebuff control, files, models — because the
bridge feeds relay messages through the daemon's normal command path and pushes
every broadcast (output chunks, chat deltas, state changes) back to the channel.

**Tailscale** is the zero-config alternative if you can install it on both
ends: `ws://<tailscale-ip>:8765/ws` behaves exactly like LAN.

### Security checklist

- The token is the root credential — treat it like a password. It lives in
  `~/.pocketdesk/config.json` and prints in the banner (dev only).
- `/pair` (the QR page) is served **only** to loopback — never exposed.
- Put TLS on for anything beyond localhost: `node scripts/gen-cert.js`, set
  `tls.enabled: true`, and pin the fingerprint shown in the app.
- The relay channel is not encryption; the token is the gate. Prefer a relay
  you control over a public one.
- Revoking a phone = change the token (and update your other devices).

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
`hello` · `detect` · `install` · `create` · `attach {since?}` · `detach` · `in` · `resize` · `kill` · `fs` · `fread` · `fwrite` · `chatsession` · `chatmsg` · `chatcancel` · `propose` · `approve` · `reject` · `proposal_list` · `chat_history` · `pin`/`unpin` · `forward_*` · `sdk_*` · `transcribe` · `gui_open {harness|path, cwd}` — open a desktop IDE on the PC at a project folder · `apps_discover {q, refresh}` — search everything installed · `audit_log`
<details>
<summary>Absorbed-feature messages</summary>

`prompt_enqueue` · `prompt_queue` · `prompt_remove` — queued follow-ups ·
`todos_set` · `todos_get` · `todos_status` — live todo boards (+ `todos_updated` broadcasts) ·
`schedule_create` · `schedule_list` · `schedule_pause` · `schedule_resume` · `schedule_cancel` — auto-continue runs ·
`doctor` — self-diagnosis report · `wake` — Wake-on-LAN magic packet ·
`approval_waiting` — chats on the auto-deny countdown ·
`usage_list` · `usage_get` — token/cost dashboards ·
`digest_attach` · `digest_detach` — live plain-text terminal digest ·
`mcp_start` · `mcp_stop` · `mcp_status` — embedded MCP endpoint control ·
`sshserver_start` · `sshserver_stop` — bind/release the PC's own SSH listener ·
`bastion_start` · `bastion_stop` — bind/release the jump host ·
`profile_connect {id, protocol, password?, passphrase?}` — real SSH/SFTP/VNC connect ·

`share_create` · `share_join` · `share_list` · `share_revoke` — read-only spectator links ·
`stats` — host CPU/mem/uptime · `git_status` · `git_diff` · `git_log` · `git_branches` — read-only repo inspection ·
`record_start` · `record_stop` · `record_list` · `record_get` — session recording/export ·
`tunnel_create` · `tunnel_close` · `tunnel_list` — TCP tunnels to PC-local services (loopback by default; pass `bindAll: true` to expose one on the LAN) ·
`power_set` · `power_status` — keep-awake · `activity_list` — per-session activity states ·
`resurrect_list` · `resume` — restore chats after a daemon restart
</details>

**Server → Client:**
`welcome` · `manifests` · `sessions` · `created` · `replay` · `out {seq}` · `exit` · `progress` · `fs` · `fchunk` · `fwritten` · `chatreplay` · `chatuser` · `chatdelta` · `chartool` · `chatstate` · `proposal_created` · `proposal_approved` · `proposal_rejected` · `activity` · `gui_opened` · `apps` · `error`

Every `out` frame carries a monotonic `seq`; on reconnect send `attach {id, since: <last seq>}` and the daemon replays only what you missed.

---

## 🧪 Testing

```bash
cd daemon
npm.cmd test                    # full suite (24 files)
node test/smoke.mjs             # session smoke tests
node test/features.test.mjs     # absorbed-features suite (shares, backfill, recording, tunnels, resurrection…)
```

The suite never leaves loopback. To exercise the SSH, SFTP and VNC transports
against a machine you actually own:

```bash
node scripts/hw-probe.mjs --host 192.168.1.20 --user dev --key ~/.ssh/id_ed25519
node scripts/hw-probe.mjs --vnc-host 192.168.1.30 --vnc-password secret
```

It connects, runs one command, uploads and downloads a file and compares it byte
for byte, then reports the VNC framebuffer geometry the server announced.

---

## 🎛️ Environment knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `RH_PORT` / `RH_TOKEN` | config file | Listen port and auth token |
| `RH_AWAKE` | `auto` | Keep PC awake: `off` / `auto` (while sessions run) / `on` |
| `RH_APPROVAL_TIMEOUT_MS` | `120000` | Auto-deny an agent stuck waiting for approval (0 disables) |
| `RH_MCP_PORT` | off | Serve the embedded MCP endpoint on localhost |
| `RH_QUIET_MS` | `20000` | Silence before a session counts as *quiet* (busy→quiet push) |
| `RH_IDLE_KILL_MINUTES` | off | Kill live sessions idle longer than N minutes |
| `RH_CLI_PORT` | `4679` | Local CLI status endpoint (`/sessions /status /query`) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOW_CHAT_IDS` | off | Two-way Telegram control (comma-separated chat IDs) |
| `NTFY_TOPIC` (+ optional `NTFY_SERVER`) | off | Phone push via ntfy.sh — install the ntfy app and subscribe to the same topic (the topic is the credential; use a hard-to-guess one). High priority on approval/error events |
| `PUSHOVER_TOKEN` + `PUSHOVER_USER` (+ `PUSHOVER_DEVICE`) | off | Phone push via Pushover (app key + user key) |
| `POCKETDESK_DATA` | `.pocketdesk` | Data dir (chat history, resurrection store) |

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

- [ ] Web-based terminal viewer with share links (browser access to spectator URLs)
- [ ] Screen bridge (WebRTC) for GUI-only apps
- [ ] Provider presets (DeepSeek, Kimi, GLM, OpenRouter)
- [ ] Cross-platform app (iOS / Desktop)
- [ ] Foreground service holding sessions through screen-off
- [ ] Diff viewer / approval cards in the app chat

One-by-one status of **every feature from the inspiration corpus** (241 reference repos):
see [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md); the **per-repo ledger** is
[docs/ABSORPTION-LEDGER.md](docs/ABSORPTION-LEDGER.md).

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
