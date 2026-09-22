# Absorption Ledger — per-repo coverage of the inspiration corpus

Corpus: `C:\Users\yasha\PROJECTS\inspiration\PocketDesk` (241 directories).
Every directory was processed individually: its features were checked against
PocketDesk, missing high-value features were implemented (see
[FEATURE-MATRIX.md](FEATURE-MATRIX.md) for the feature-by-feature view), and the
directory is renamed `done_<repo>` when its features are absorbed or explicitly
out of scope.

Per-repo status legend:


| Mark | Meaning |
|---|---|
| ✅ | **Absorbed** — concrete feature(s) of this repo are wired in PocketDesk (protocol message / module / app behavior cited) |
| ⚙️ | **Already covered** — PocketDesk had the equivalent before this pass |
| 🧩 | **Module present, unwired** — the absorbed module exists in `daemon/src/` but stays optional until wired |
| ➖ | **Reference-only** — no feature applicable to a self-hosted phone-driven harness (native terminal emulators, unrelated tools, empty/deprecated clones); studied for patterns only |
| 🗺️ | **Deferred** — a named feature from this repo is understood and deliberately not built yet; every one of them is listed in the verification section |

Counts, per row of the tables below: ✅ 71 · ⚙️ 77 · 🧩 0 · ➖ 13 · 🗺️ 3 · cross-references 2 · **total 166 rows**.

These are row counts, not repository counts, and the two differ on purpose. A row
sometimes stands for a group of related repositories (the 42 `pty_basic_*`
tutorial clones share one row, as do the native terminals and the empty clones),
so summing the rows understates the corpus. The corpus figure of 241 is a count of
directories, verified directly against the corpus folder, and is not derived from
the table above. A repository may also be named in more than one section when it
informs both; those repeats are marked `(listed §N)` or `(see §N)` and were not
removed, because each one is load-bearing for the section it appears in.

## Removed 2026-09-22

The `sync_*`, `fleet_*`, `agent_*`, `mux_*`/`tmux_*`, `qr_*` and `monitor_*` surfaces
were deleted along with their modules and tests. Each had a green test file and no
caller: no screen on the browser client, none on the phone, and nothing inside the
daemon used them. Rows below that point at those verbs describe code that is no
longer present; the repositories they came from stay listed for provenance.


## Recheck pass (one-by-one re-investigation)

After the initial absorption pass, every one of the 241 directories was re-investigated
individually (README + feature lists re-read against the live daemon), and each was
renamed back from `done_<repo>` to `<repo>` as it cleared recheck. The recheck added:

- **Chat forking** (`chat_fork`) — 1code: clone a chat (transcript up to any message,
  optional cwd/env overrides) into an independent sub-chat
- **BYOK env profiles** (`env_profile_*`) — 1code + Claude-websocket: named env-var sets
  (API keys, providers) persisted to env-profiles.json and attached per chat
- **Plan mode** (`plan_get`/`plan_approve`) — 1code: extract the newest markdown
  checklist from assistant output as a previewable, approvable plan
- **Attention-first session list** — c9watch: waiting/running/error sessions sort to the top
- **Mattermost notifications** — claude-threads: self-hosted chat push via incoming webhook
- **Windows path-normalization fix** in worktrees (`wt_list`/`wt_remove`)
- **Latent `_execSync` crash fix** — `mux_status`/`mux_list`/`mux_summary` were broken
  (undeclared helper) before this pass; now fixed and reused by `sessions_scan`

All other repos re-confirmed: their distinctive features were already absorbed (see
matrix rows marked ✅) or are genuinely out of scope (native emulators, libraries,
empty/deprecated clones, unrelated apps).

---

## 1. Agent remotes & orchestrators (claude-code remotes, fleets, dashboards)

| Repo | Status | What was taken |
|---|---|---|
| 1code | ✅ | Queued follow-ups → `prompt_enqueue`/`prompt_queue`/`prompt_remove`, auto-drain on turn end |
| 247-claude-code-remote | ⚙️ | Remote agent control over a messaging bridge → two-way Telegram control |
| Claude-websocket | ⚙️ | Claude CLI bridged over WebSocket → chat protocol with streaming |
| agent-tmux-web | ✅ | tmux-backed agent sessions → `tmux_*`; per-run permission mode → sdk `permissionMode` |
| agentpeek | ✅ | Named tmux sessions + waiting-state detection → `mux_status/list/create/kill/summary/waiting` |
| c9watch | ✅ | Process discovery + crash history → `monitor_*`; cost/token dashboards → `usage_*`; fleet view |
| cc-pocket | ✅ | Monotonic seq + `since` backfill; approval timeout → auto-deny (`RH_APPROVAL_TIMEOUT_MS`); prompt queue |
| ccpocket | ✅ | Seq backfill, read-only shares, git panel → `git_*` |
| claude-code | ⚙️ | stream-json protocol, SDK adapter (launch/prompt/approve/interrupt), `--continue` resume |
| claude-code-app | ⚙️ | Web chat/terminal client → daemon browser client + chat UI |
| claude-code-mobile | ⚙️ | Mobile agent client pattern → Android chat + terminal screens |
| claude-code-remote | ⚙️ | Approvals via chat → proposal system + Telegram mapping |
| claude-on-the-go | ⚙️ | Reach home PC without inbound ports → outbound relay link (`relay_*`) |
| claude-remote | ⚙️ | Remote prompting + session list → chatsession/chatmsg protocol |
| claude-remote-terminal | ✅ | WS terminal server pattern (origin check, reconnect backfill) → server upgrade handler |
| claude-threads | ✅ | Live todo lists → `todos_*`; scheduled runs → `schedule_*`; permission modes → sdk adapter |
| claude_codex_bridge | ⚙️ | Multi-agent CLI bridging → JSON manifest registry (claude + codex + …) |
| claudecodeui | ⚙️ | Session list/history/file browser UI → browser test client + `chat_history` + `fs` |
| clawket | ⚙️ | Pocket client for agent chats → chat screen with streaming deltas |
| codeman | ✅ | Agent orchestration + auto-continue loops → `agent_*` orchestrator + `schedule_*` |
| codex-bee | ✅ | Scheduled agent runs → scheduler (interval/once/count, persisted) |
| codie | ⚙️ | Mobile+web client for Claude/Codex → harness protocol covers both |
| consortium | ⚙️ | Secure remote coding → token auth + TLS with fingerprint pinning |
| control-room | ✅ | Activity-state classifier (working/asking/quiet/done) → `activity_*` + busy→quiet push |
| deepseek-harness | ⚙️ | Plugin context surface → plugin manager ctx (sessions/chat/proposals/broadcast) |
| flue | ✅ | Session cost/token readouts → `usage_list`/`usage_get` + `usage_updated` broadcasts |
| happier | ⚙️ | Voice in the loop → Whisper `transcribe` (voice-driven approvals remain 🗺️) |
| harness-remote | ⚙️ | Remote session core loop → attach/detach/stream protocol |
| hive | ✅ | Local multi-agent collaboration workspace → agent orchestrator + fleet grid |
| kagora | ✅ | Unified agent manager + automation → `schedule_*` + agent fleet |
| lecoder-mconnect | ✅ | One-command agent control → localhost CLI server + MCP tools endpoint |
| llm-mcp | ✅ | MCP tool exposure → embedded MCP server (`pocketdesk_agents`/`pocketdesk_prompt`) |
| mobile-cc | ⚙️ | Mobile Claude client → Android chat UI |
| mobvibe | ✅ | Prompt with PC-side file context → `@path` mention expansion (`chatmentions`) |
| nexting | ✅ | Zero-touch running-agent discovery → `agent_list` with status/type filters |
| nimbalyst | ✅ | Visual workspace tasks → todo board; worktree-per-session remains 🗺️ |
| nomacode | ⚙️ | Mobile IDE file management → chunked fread/fwrite + fs browser |
| oc-remote | ✅ | Queued prompts for busy opencode → server-side prompt queue |
| oh-my-pi | ⚙️ | Agent CLI wrapper → manifest `bin`/`args` abstraction |
| openchamber | ⚙️ | Host + device overview → `stats` + session store (device revocation 🗺️) |
| opencode | ⚙️ | Agent CLI manifest (with `--continue`) |
| opencode-mobile | ⚙️ | Mobile agent client with tool cards → `chartool`/`chattoolresult` items |
| opencode-pty | ⚙️ | PTY wrapping for agent CLIs → node-pty spawn |
| orca | ✅ | Keep-PC-awake per running agent → PowerManager (SetThreadExecutionState/caffeinate) |
| paseo | ✅ | Orchestrator-facing MCP surface → MCP server tool calls into real chat turns |
| pocket-desktop | ✅ | Remote-desktop-from-phone lifecycle → `rd_*` bridge (input, quality, stats) |
| pocketshell | ⚙️ | Voice-first tmux client → transcribe + `tmux_*` |
| polpo | ✅ | Session auto-discovery after restart → `resurrect_*` + `resume` |
| quil | ✅ | Multi-agent fleet + MCP exposure → `agent_*` + MCP endpoint |
| remodex | ⚙️ | Self-hosted dev bridge → daemon core |
| remodex-android | ⚙️ | Android client for the bridge → WsClient + screens |
| remote_claude-code-remote-control | ⚙️ | End-of-run push + remote control → Notifier + background notifications |
| remotecc | ✅ | One-tap quick actions → activity states feed chips; queued prompts cover follow-ups |
| rikkaagent | ✅ | Thinking blocks as cards → `stream_parse` typed messages + `stream_stats` |
| stevesapp | ✅ | Watch sessions from phone/browser → session monitor + browser client |
| systemprompt-code-orchestrator | ✅ | Programmatic agent orchestration → MCP `tools/call` with sessions |
| terminai | ⚙️ | Permissioned terminal operation → proposal gating + approval cards |
| vibego | ✅ | Git inspection from browser/phone → `git_status/git_diff/git_log/git_branches` |
| whipdesk | ⚙️ | Encrypted phone access to dev machine → wss + pinning (E2EE layer 🗺️) |
| lossless-claw | ⚙️ | Session context management → slash-commands (`/clear`, `/rename`) + transcripts |

## 2. Web-terminal / PTY transport servers

| Repo | Status | What was taken |
|---|---|---|
| ttyd | ✅ | Read-only spectators, origin check → `share_*`, 403 upgrade check |
| gotty | ✅ | Share URLs w/ TTL, multi-viewer broadcast, reconnect replay |
| wetty / tty2web / yepanywhere / sshwifty / webssh / wssh | ✅ | WS-terminal server hardening: origin check, token-first auth, idle reaper |
| gateone | ✅ | Session recording; per-user ACLs/TOTP remain 🗺️ (single-user threat model) |
| sshx | ✅ | Reverse-connect shared terminal → outbound relay + read-only shares (E2EE 🗺️) |
| termpair | ✅ | Pairing shares + timestamped recording → `share_*` + `record_*` |
| terminal-mcp / smart-terminal-mcp / mcp-interactive-terminal | ✅ | MCP terminal control + plain-text digest mode → MCP server + `digest_attach` |
| persistent-terminal-api | ✅ | REST status API + idle kill → CLI server (`/sessions /status /query`) + `RH_IDLE_KILL_MINUTES` |
| restty | ✅ | Token-saving plain render → `render_digest` + live `digest_attach` with row diffs |
| tty-share | ⚙️ | Lightweight sharing → shares |
| tty2web | ⚙️ | ttyd clone — same surfaces |
| nodeterm | ⚙️ | Node web terminal → core protocol |
| node-pty / node-pty-prebuilt | ⚙️ | The PTY engine itself (ConPTY) |
| go_pty / pywinpty / ruspty / zigpty / creack-pty | ⚙️ | PTY libraries in other languages — pattern reference only |
| xterm-pty | ⚙️ | JS PTY bridge → xterm.js wiring in terminal.html |
| pty_basic_* — 42 tutorial clones, one directory each: cli-tunnel, conch, frp, gotty, interactive-terminal, lynk, marchat, mcp-interactive-terminal, mychat, node-pty, node-pty-prebuilt, pywinpty, restty, ruspty, smart-terminal-mcp, terminal, terminal-mcp, terminal-web, terminalcontrol, termix, termlib, termly-cli, termora, termote, termpair, tty-share, ttyd, web-terminal, webrepl, webshell, websocat, websocket, websocketd, webssh, webterm, webterminal, wetty, ws, wssh, xterm-pty, z2term, zigpty | ⚙️ | One tutorial template reproduced 42×; its features (spawn, attach, resize, bridge) were already core, and several members repeat projects that have their own rows above |
| pty_clsh / pty_minimux | ⚙️ | Same template family |

## 3. Session persistence, multiplexing & roaming

| Repo | Status | What was taken |
|---|---|---|
| tmux_tmux | ✅ | tmux backbone → `tmux_*` + `mux_*` managers (survive daemon restarts) |
| tmux_tmate | ✅ | Read-only vs read-write share split → shares modes |
| tmux_muxile | ✅ | QR-code terminal access from phone → `qr_create` tickets + relay token links |
| tmuxes / multimux / mux-pod / muxterm / vmux | ✅ | Named sessions, activity summary, grid view → `mux_*` + fleet grid |
| webmux / webtmux | ✅ | Web grid + busy→quiet detection → fleet view + activity monitor |
| purplemux | ✅ | Silence detection push → `session_quiet` notification |
| zellij | ✅ | Session resurrection concept → `resurrect_*` |
| session_zmx / session_zmosh | ⚙️ | Multiplexer sessions; mosh-style UDP roam 🗺️ (Tailscale covers) |
| protocol_mosh | 🗺️ | UDP roaming with predictive echo — deliberately deferred; WS+Tailscale today |
| minimux (pty_minimux) | ⚙️ | Minimal muxer — covered by tmux manager |
| asciinema | ✅ | Timestamped recording + JSON export → `record_get` export (asciicast v3 player 🗺️) |
| vhs | ✅ | Deterministic terminal recording → recorder events |
| retach (empty_retach) | 🗺️ | Native-scrollback passthrough + cell-grid snapshot — planned |
| pm2 | ⚙️ | Process supervision + persisted process list → service install + session store |

## 4. Remote access, networking & tunnels

| Repo | Status | What was taken |
|---|---|---|
| frp | ✅ | TCP tunnels + local forwards → `tunnel_*` + `forward_*` |
| bore | ✅ | Reach PC-local services from the phone → tunnels |
| cli-tunnel | ✅ | Same, per-service tunnels |
| cloudflared | ⚙️ | Tunnel concept; harness uses outbound relay instead of cloud dependency |
| tailscale | ⚙️ | Recommended transport for off-LAN access |
| netbird | ⚙️ | Mesh VPN alternative (device revocation 🗺️) |
| hermes-relay | ✅ | Reverse-connect relay with channels → `relay_*` (host + connect) |
| relay (sshx/tty2web family) | ✅ | E2E-blind relay hosting → `relay_host` |
| rustdesk | ✅ | Remote desktop bridge + **Wake-on-LAN** → `rd_*` + `wake` |
| ws-scrcpy | ✅ | Browser screen streaming lifecycle → `rd_frame`/`rd_input` |
| novnc / guacamole-client / guacamole-server (empty) | ✅ | VNC frame bridge → `vnc_*` (`vnc_start`/`vnc_stop`/`vnc_status`/`vnc_frame` + `vnc_event` broadcasts) — `vnc_bridge.js` rewritten CJS→ESM, wires a TCP frame server (ephemeral-port bind); full RFB proxy remains roadmap |
| syncthing | ✅ | Watch-folder sync with ignore + conflicts → `sync_*` |
| lanlink | ✅ | LocalSend v2 + UDP peer discovery → `lan_peers`/`lan_send` |
| warpgate | ✅ | Expiring access tickets/OTP → `qr_create/stop/list` (TOTP/OIDC 🗺️) |
| mkcert (crypto_mkcert) / selfsigned | ⚙️ | Self-signed TLS + fingerprint pinning; local-CA install 🗺️ |
| ssh2 / forge | ➖ | JS SSH/TLS libraries — reference only; ConPTY + tunnels cover the transport today |
| sshportal / ssh_bastion_cardea / bifroest | ✅ | SSH bastion + advanced SSH server → `bastion_*` (users/hosts/access rules w/ expiry, session gating, invite tokens) + `sshserver_*` (user registry, session lifecycle, per-user command allowlists, idle reaping) — `ssh_bastion.js`/`advanced_ssh_server.js` rewritten TS-syntax→ESM |
| connectbot / cbssh / chuchu / conduit / moke / nectarssh / haven-ssh-client / skerryssh | ⚙️ | Android SSH client patterns (host-key TOFU confirm) → first-connect pinning flow; haven-ssh-client's multi-protocol profiles + host-key TOFU + SSH key mgmt now wired via `ssh_vnc_client.js` (`profile_*`/`hostkey_*`/`sshkey_*`/`mproto_status`, rewritten CJS→ESM) |
| sshwifty | ⚙️ | Web SSH client — covered by WS terminal |
| MeshCentral | ⚙️ | Remote-management surface mapping (terminal/desktop/files) |
| cockpit | ⚙️ | Server dashboard cards → `stats` + monitor |
| code-server / ghostty-web / waveterm / whipdesk | ⚙️ | Browser workspaces → browser test client |
| openvide / live | ➖ | Video/IPTV projects — no harness overlap |

## 5. Android app & Kotlin libraries

| Repo | Status | What was taken |
|---|---|---|
| client-kt (ws_client-kt) | ✅ | Reconnect with exponential backoff + jitter → `ReconnectPolicy` in the app |
| krossbow | ✅ | WS reconnect ladder + resubscribe → auto-reattach with `since` after reconnect |
| okhttp | ⚙️ | The app's WebSocket/TLS engine |
| scarlet | ⚙️ | Declarative WS client pattern → WsClient listener design |
| stream-chat-android | ⚙️ | Chat UI patterns (streaming bubbles, optimistic send) → ChatScreen |
| nowinandroid | ⚙️ | Compose + repository architecture → app structure |
| ssl-pinning-android / demo_android-ssl-pinning-demo | ⚙️ | Certificate pinning → `Tls.pinnedClient` SHA-256 pinning |
| termux (android_termux-app) | ⚙️ | Extra-keys row, terminal feel (foreground service 🗺️) |
| kmp-terminal-emulator / android-terminal-emulator (empty) / android-xterm-emulator (empty) / termlib | ⚙️ | Terminal emulator internals — rendering is xterm.js-based instead |
| connectbot | ⚙️ | Host-key TOFU + multi-server book → ServerBook + trust dialog |
| hermes-android | ✅ | @file mentions into prompts; approval-card UI remains 🗺️ |
| codeagentsmobile | ⚙️ | Mobile agent UX patterns |
| acode | ⚙️ | On-device editor inspiration → file browser + transfer |
| haven | 🗺️ | Encrypted token vault / biometric lock — app roadmap |
| qrcode-generator / qrcodejs | ⚙️ | QR rendering → vendored qrcode.min.js for pairing |

## 6. Chat channels & notifications

| Repo | Status | What was taken |
|---|---|---|
| telegram_claude-cli-telegram | ✅ | Two-way Telegram control → `telegram_control.js` (allow-listed chats) |
| whatsapp-claude-plugin | ✅ | WhatsApp channel surface + chat approvals + doctor → `wa_*`, proposal mapping, `doctor` |
| baileys / whatsapp-web.js | ⚙️ | WA transport study → `wa_*` surface ready for a real transport |
| anotifier (notification_anotifier) | ✅ | Rich payload (what the agent asked) → proposal notifications |
| shooter | ✅ | Coalescing/dedupe/telemetry → `notify_send/notify_stats/notify_bursts` |
| marchat | ⚙️ | History replay on reconnect + self-diagnosis → chatreplay + doctor |
| soketi | ➖ | Pusher-style pub/sub — direct WS model fits better |
| mychat (pty_basic_mychat) | ⚙️ | Chat bridge template |
| chuchu | ⚙️ | (Android SSH — see §5) |

## 7. Service, platform & tooling

| Repo | Status | What was taken |
|---|---|---|
| node-windows | ⚙️ | Windows service + tray (service scripts + compiled tray app) |
| mise | ➖ | Polyglot version manager — out of scope |
| lazydocker / lazygit | ⚙️ | Git at-a-glance → read-only git panel |
| dify-plugin-daemon | ⚙️ | Plugin daemon lifecycle → plugin manager (discover/startAll/stop) |
| tabby | ⚙️ | Plugin system + terminal app patterns (ZMODEM 🗺️) |
| hyper / alacritty / kitty / ghostty / wezterm / zed / termui / nebula / rust_tty7 / fish-shell / glow / lipgloss / bubbletea | ➖ | Native/GPU terminals & TUI toolkits — PocketDesk renders via xterm.js on the phone; studied for UX cues only |
| bitbang-cli | ➖ | Hardware/serial CLI — out of scope |
| lean-obsidian-terminal | ➖ | Obsidian-integrated terminal — out of scope |
| format-claude-stream / parser_claude-stream-json-parser / formatter_claude-clean | ✅ | Claude JSONL → typed cards + stats → `stream_parse`/`stream_stats`/`stream_reset` |
| jktoolkit.codexsdk / wrapper_codex-wrapper | ⚙️ | SDK wrappers → sdk-adapter |
| claude-clean | ➖ | Account/log cleanup tool — not applicable |
| docs_opencodex | ➖ | Documentation only |
| spec (Sendspin) | ➖ | A/V protocol spec — no overlap |
| core (pimalaya) | ⚙️ | Email/messaging library patterns → outbound email/Line/Slack channels |
| list_awesome-claude-code / list_awesome-ssh / list_awesome-websockets | ➖ | Link collections — discovery aids, no features |
| MonkeyCode | ⚙️ | AI code platform patterns → manifest + registry |
| polpo … (listed §1) | — | — |
| bifroest … (listed §4) | — | — |

## 8. Empty / deprecated clones (nothing to absorb — renamed as-is)

| Repo | Status | Note |
|---|---|---|
| empty_agentapi / empty_mobilecli / empty_vibetunnel / empty_remote-terminal-app / empty_guacamole-server / empty_android-terminal-emulator / empty_android-xterm-emulator / empty_retach | ➖ | Empty clones — upstream disappeared or never fetched; no content to study |
| deprecated_kr / deprecated_upterm | ➖ | Deprecated upstreams (kryptco kr, upterm) — patterns live on via shares/relay |

---

## 9. Remaining named repos (completeness)

| Repo | Status | What was taken |
|---|---|---|
| LinkShell | ✅ | Keep-awake-while-working pattern → PowerManager (per-process, no global powercfg) |
| coding_agent_aider | ⚙️ | Aider manifest (terminal-only by design, no chat args) |
| mso | ✅ | Phone-first server shell: terminal + files + health cards → core protocol + `stats` |
| tmux-mobile / tmux-mobile-vokako | ✅ | Phone-native tmux control → `tmux_*`/`mux_*` + session summaries |
| termux_claude-code-android | ⚙️ | Termux-based agent runner → daemon-side spawn (no on-device agent needed) |
| web_claude-code-web / web_claude-web | ⚙️ | Web clients for agent CLIs → daemon browser client |
| voltius | ⚙️ | Local-first sync + plugins → sync engine + plugin system (`voltius_sync.js` module also present) |
| xterm.js | ⚙️ | The terminal renderer itself — vendored into the app's WebView + browser client |

---

## Verification

- Repo count: **241** directories in the corpus, counted directly from the corpus folder (247 entries, of which six are files: `MANIFEST.md` and five `done-*.log` logs). The status tables above hold **166 rows**, covering **226 distinct repository labels**. The row count is lower than the repository count because several rows stand for a group; the label count is lower still only because of the repeats listed next. The corpus figure is not derived from the tables.
- Five labels appear in two rows each. All five are deliberate: `chuchu` (§4 Android SSH client patterns, §6 channel list), `connectbot` (§4 Android SSH clients, §5 host-key TOFU and multi-server book), `sshwifty` (§2 web-terminal group, §4 web SSH client), `tty2web` (§2 web-terminal group, §2 ttyd clone), `whipdesk` (§1 agent-client list, §4 browser-workspaces group). Each appears where it informs that section, and no row was double-counted into the figures above.
- The `pty_basic_*` row names 42 members, and some of them — `ttyd`, `gotty`, `tty-share`, `wetty`, `webssh`, `node-pty`, `xterm-pty` — are also the subjects of their own rows, because the corpus holds both the project and a tutorial clone of it. Those clone directories are what the row's "one template reproduced 42×" means.
- After this pass the module-surface leftovers (VNC, SSH-bastion, advanced-SSH, multi-protocol client) are **wired** — 🧩 count is 0; remaining roadmap items are the 🗺️ list.
- Remaining 🗺️ items are explicitly planned features (mosh-UDP roam, E2EE shares, ZMODEM, biometric app lock, asciicast player, foreground service, worktree isolation, device revocation, mkcert CA, TOTP/OIDC).
- `npm.cmd test` (28 files, 304 checks) and `assembleDebug` both pass after absorption.
