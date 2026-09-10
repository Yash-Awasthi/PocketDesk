# Feature Matrix — inspiration corpus vs PocketDesk

One-by-one coverage of every distinct feature found in the 220-repo inspiration
corpus (`/inspiration/PocketDesk`), mapped to what PocketDesk ships.

Status legend:

| Mark | Meaning |
|------|---------|
| ✅ | **Wired now** — implemented in the live daemon this absorption pass, protocol-tested |
| ⚙️ | **Already wired** — existed and worked before this pass |
| 🧩 | **Module present, unwired** — standalone module in `daemon/src/` exists but isn't reachable from the protocol (some are broken: TS syntax in `.js`, CJS in ESM) |
| 🗺️ | **Planned** — worthwhile, not yet built |
| ➖ | **Not applicable** — doesn't fit a self-hosted phone-driven harness |

---

## 1. Terminal & PTY transport  *(ttyd, gotty, wetty, tty2web, yepanywhere, sshwifty, gateone, xterm.js, node-pty, warpgate, tabby, termix, …)*

| Feature | Source repos | Status |
|---|---|---|
| PTY create/attach/detach/input/resize/kill over WS | node-pty family (the ~50 `pty_basic_*` clones are one tutorial template) | ⚙️ |
| Scrollback replay on attach | gotty, ttyd | ⚙️ |
| Monotonic seq numbers on output + missed-output backfill (`attach {since}`) | cc-pocket, ccpocket, codeman, gotty reconnect | ✅ `seq` on `out`, incremental `replay` |
| Read-only spectator mode (server-enforced input drop) | ttyd, gotty, tty2web, termpair, tmate ro-keys | ✅ `share_create`/`share_join` |
| N-viewer broadcast of one session | gotty, ttyd, interactive-terminal | ✅ (share + multi-subscriber attach) |
| Share tokens with TTL + revoke | gotty URLs, tty-share | ✅ `share_*` (expiry sweep, `share_revoke`) |
| Origin check on WS upgrade | ttyd, gotty | ✅ 403 at HTTP upgrade |
| Idle-session reaper | persistent-terminal-api | ✅ `RH_IDLE_KILL_MINUTES` |
| Session recording with timestamps + export | asciinema, termpair, terminal-mcp, gateone | ✅ `record_*` (SessionRecorder wired) |
| tmux-backed detach (process survives daemon restart) | terminal-web, webtmux, multimux | ✅ `tmux_*` (list/create/kill/resize/keys/capture, `available` flag, graceful without tmux) |
| ZMODEM/trzsz in-band file transfer | ttyd, tabby | 🗺️ |
| Read-only/plain-text digest render (token savings) | mcp-interactive-terminal | ✅ `render_digest` → `digest_render` (ANSI-stripped plain rows, trailing blank trimmed; `terminal_renderer.js` ported CJS→ESM) + ✅ `digest_attach` live digest mode (diffed row updates streamed to cheap subscribers) |
| Per-user ACLs / TOTP / OIDC | warpgate, gateone | 🗺️ (single-user threat model today) |
| Reverse-connect relay / E2E blind relay | tty2web, yepanywhere, sshx | ✅ `relay_*` — outbound relay link (phone can reach the PC off-LAN) + optional relay hosting; `relay_server.js` ported CJS→ESM |
| REST command API alongside WS | persistent-terminal-api, tty2web | ⚙️ (CLI server `/sessions /status /query`) |
| One-shot mode, DNS-tunnel transport | gotty, tty2web | ➖ |

## 2. Session persistence & roaming  *(tmux, zellij, zmx, zmosh, mosh, tmate, upterm, muxile, retach, pm2, …)*

| Feature | Source repos | Status |
|---|---|---|
| Chat session resurrection across daemon restart (resume via CLI history) | zellij resurrection, tmux-resurrect, polpo | ✅ `resurrect_*` + `resume` (`resumeFirst` uses `resumeArgs`) |
| Metadata persistence (sessions store on disk) | pm2 process list | ⚙️ session-store |
| Missed-output backfill after reconnect | cc-pocket, ccpocket, codeman | ✅ (seq ring buffer, 2000 chunks) |
| Native-scrollback passthrough (plain text lines for touch scroll) | retach | ✅ `chat_text` renders the full transcript as plain text |
| Cell-grid snapshot replay (restore vim/htop screens) | muxterm, retach, zellij | 🗺️ |
| mosh-style UDP roam (auth datagrams, state diff, predictive echo) | mosh, zmosh, zmx | 🗺️ (WS+TCP for now; Tailscale covers roaming) |
| Boot persistence (service/launchd start) | pm2, muxterm | ⚙️ install-service.ps1 + tray |
| remain-on-exit + respawn | tmux | ✅ tmux respawn-config on session create; `remain_on_exit` |
| Windows/panes/layouts | tmux, zellij, muxterm | ✅ `mux_status`/`mux_list`/`mux_create`/`mux_kill`/`mux_summary`/`mux_waiting` — named tmux sessions with activity + waiting-state detection; graceful gate on tmux-less hosts |
| Git-worktree-per-agent | vmux, orca, ccpocket | ✅ `wt_create`/`wt_list`/`wt_remove` (worktrees.js) |
| Asciicast export with player | asciinema | ✅ asciicast v2 export (`record_asciicast`) + JSON export (`record_get`) |
| Read-only vs read-write share split | tmate, termpair | ✅ |

## 3. Agent control  *(claude-code-remote, claudecodeui, cc-pocket, mobvibe, oc-remote, c9watch, codeman, control-room, agentapi, …)*

| Feature | Source repos | Status |
|---|---|---|
| Chat streaming w/ tool events (claude stream-json, codex-json, text) | claude-code, claude-stream-json-parser | ⚙️ |
| Conversation resume | claude-code `--continue`, codex `exec resume --last` | ⚙️ |
| SDK adapter (launch/prompt/approve/interrupt/subscribe) | claude-code SDK, codex SDK | ⚙️ |
| Queued follow-ups while agent runs | 1code, ccpocket, oc-remote | ✅ `prompt_enqueue`/`prompt_queue`/`prompt_remove` — server-side queue drains automatically when the turn finishes (phone can enqueue and walk away) |
| Permission-mode switching per run | agent-tmux-web, claude-threads, control-room | ✅ `chat_permission` runtime switch per chat |
| Proposals / approval gating | claude-code-hermit | ⚙️ |
| Approval timeout → auto-deny | cc-pocket | ✅ proposals auto-expire + ✅ run-level auto-deny (`RH_APPROVAL_TIMEOUT_MS`, `approval_waiting`, auto-cancel of the waiting chat so queued prompts flow) |
| Cost/token dashboards, context-window readout | c9watch, flue, orca, cc-pocket | ✅ `usage_list`/`usage_get` + live `usage_updated` (input/output/cache tokens + cost from stream-json result events) |
| Thinking/reasoning blocks as collapsible cards | rikkaagent, oc-remote, format-claude-stream | ✅ `stream_parse` (JSONL → typed messages + formatted cards) + `stream_stats` (tokens, pending tools) + `stream_reset`; parser ported TS→ESM |
| Live todo/task list of running session | c9watch, claude-threads, codeman | ✅ `todos_set`/`todos_get`/`todos_status` + live `todos_updated`; board also auto-derived from markdown checkboxes in the finished turn's last assistant message |
| Activity-state classifier (working/asking/done) driving alerts | control-room, codeman, agent-tmux-web | ✅ `activity_*` + `activity` broadcasts |
| Busy→quiet detection with push | webmux, purplemux | ✅ (quiet → `session_quiet` notification) |
| Fleet dashboard across sessions | c9watch, quil, codeman, control-room | ✅ `agent_*` (orchestrator-backed fleet) + ✅ `fleet_*` (grid dashboard: add/remove/focus/resize, status→chips, stats, live `fleet_event` broadcasts); agent state changes project into the grid automatically |
| Attention-first session list (stuck agents surface to top) | c9watch | ✅ `sessions` ordering: waiting → running → error → rest |
| Chat forking (sub-chat from any message) | 1code | ✅ `chat_fork` — clones transcript up to message N, optional cwd/env overrides |
| BYOK env profiles per chat | 1code, Claude-websocket | ✅ `env_profile_set/attach/detach/list/remove` — named API-key/model env sets persisted to env-profiles.json |
| Plan mode (structured plan preview + approval) | 1code | ✅ `plan_get`/`plan_approve` — extracts newest markdown checklist from assistant output |
| Zero-touch session discovery (scan running agents) | c9watch, nexting | ✅ `agent_list` filters + `sessions_scan` OS process scan |
| Auto-continue loops / scheduled runs / cron | codeman, codex-bee, claude-threads, kagora | ✅ `schedule_create`/`schedule_list`/`schedule_pause`/`schedule_resume`/`schedule_cancel` — interval/once/count jobs, persisted to schedules.json, fire prompts into chats (or `chatId: "newest"`) |
| Session fork/rename/search/export | 1code, oc-remote, flue | ✅ `chat_fork` + `chat_search` + rename + history export |
| Diff review + git actions from phone | cc-pocket, vibego, orca | ✅ read-only `git_status/git_diff/git_log/git_branches`; staging/commit via agent |
| Quick-reply chips (y/continue/approve) | webmux, remotecc | 🗺️ (client-side; daemon state via `activity` ready) |
| @file mentions / file attach into prompt | hermes-android, mobvibe, agent-tmux-web | ✅ `@path` expansion in chat prompts (size-capped inline fenced blocks anchored at chat cwd; `chatmentions` report frame; uploads still exist) |
| Expose harness as MCP server | quil, systemprompt-code-orchestrator, paseo | ✅ embedded MCP endpoint (JSON-RPC 2.0 over localhost HTTP, `tools/list` + `tools/call` → real chat turns with `pocketdesk_agents`/`pocketdesk_prompt`); env `RH_MCP_PORT`, protocol `mcp_start`/`mcp_stop`/`mcp_status` |
| Worktree isolation per session | orca, claude-threads, paseo | ✅ `wt_create`/`wt_list`/`wt_remove` — per-agent git worktrees (worktrees.js) |

## 4. Remote access & networking  *(frp, bore, cloudflared, tailscale, netbird, rustdesk, ws-scrcpy, guacamole, code-server, …)*

| Feature | Source repos | Status |
|---|---|---|
| LAN/Tailscale WebSocket + TLS w/ SHA-256 pinning | — | ⚙️ |
| QR pairing (loopback page, deep link) | — | ⚙️ |
| TCP forwarding (phone → PC-local services) | frp, bore, cli-tunnel | ✅ `tunnel_*` (TunnelManager wired) |
| Port forwarding (daemon-side, local listener → remote host) | ssh, frp | ⚙️ `forward_*` |
| LAN file transfer w/ UDP discovery (LocalSend protocol) | lanlink, syncthing | ✅ `lan_peers` (UDP discovery, lazy start) + `lan_send` (LocalSend v2 push, byte-verified e2e) |
| Watch-folder file sync w/ ignore patterns + conflict copies | syncthing | ✅ `sync_devices`/`sync_folders`/`sync_files` CRUD + `sync_file_add`/`sync_file_synced` + `sync_conflict`/`sync_conflict_resolve` + `sync_stats`/`sync_events`, live `sync_event` broadcasts |
| Self-hosted relay fallback / hole punching | netbird, rustdesk, frp XTCP, tty-share proxy | 🗺️ |
| mkcert-style local CA install (no cert warnings) | mkcert, selfsigned | 🗺️ (pinning covers it today) |
| Remote desktop / screen streaming | rustdesk, ws-scrcpy, novnc, guacamole | ✅ `rd_*` (session lifecycle w/ async connect, frame buffering, input forwarding, quality presets, stats) — TS→ESM port; full WebRTC video remains roadmap (frame relay transport is simulated) |
| VNC frame bridge (TCP frame server + frame feed) | novnc, guacamole-server | ✅ `vnc_start`/`vnc_stop`/`vnc_status`/`vnc_frame` + `vnc_event` broadcasts — `vnc_bridge.js` CJS→ESM, ephemeral-port bind, frame push to TCP clients; full RFB proxy remains roadmap |
| SSH jump-host / bastion access control | sshportal, ssh_bastion_cardea, bifroest | ✅ `bastion_*` — users/hosts registry, access rules w/ expiry, session gating, invite tokens (`bastion_user_add/host_add/rule_add/access/session_start/session_end/sessions/stats/invite/invite_accept`) |
| SSH server auth + per-user command allowlists | bifroest, sshwifty | ✅ `sshserver_*` — user registry, session lifecycle, allowlisted commands w/ recording, idle reaping (`sshserver_user_add/session_create/exec/session_end/sessions/stats`) |
| Wake-on-LAN | rustdesk | ✅ `wake` — magic-packet UDP broadcast (multi-MAC, custom port/address) |
| Device list + revocation | openchamber, netbird | ✅ `device_list`/`device_revoke`/`device_allow` — persisted registry keyed on hello clientId |
| Expiring access tickets / OTP | warpgate | ✅ `qr_create`/`qr_stop`/`qr_list` — OTP-style token tickets on a dedicated relay port; phone connects directly with `?token=`, gets live output + can type back; wrong token rejected; TTL expiry built in |
| mDNS/LAN auto-discovery of the daemon | claude-remote-terminal, ccpocket | 🗺️ (LAN transfer discovery exists to build on) |

## 5. Mobile client  *(connectbot, termux, kmp-terminal-emulator, client-kt, stream-chat-android, remodex-android, hermes-android, …)*

| Feature | Source repos | Status |
|---|---|---|
| WS client w/ token auth, TLS pinning, multi-PC list | — | ⚙️ |
| QR scan pairing + deep link | — | ⚙️ |
| Terminal w/ extra keys row | — | ⚙️ |
| Chat UI w/ streaming + tool indicators | stream-chat-android patterns | ⚙️ |
| Background end-of-session notifications | — | ⚙️ |
| Auto-reconnect with exponential backoff + jitter | client-kt, krossbow | ✅ app-side `ReconnectPolicy` (1s→30s exp + 20% jitter, 8 attempts) + auto-reattach with `since` seq after reconnect (status `Reconnecting` shown) — daemon-side the **relay link** auto-reconnects with capped exponential backoff + equal jitter (`relay.js`, behavioral tests in `reconnect.test.mjs`) |
| Foreground service holding sessions through screen-off | termux, nectarssh | 🗺️ |
| Reattach with `since` seq after reconnect | cc-pocket | ✅ protocol + ✅ app adoption (WsClient tracks last seq per session and reattaches incrementally) |
| Tool-approval cards + inline diff viewer | opencode-mobile, hermes-android | 🗺️ app |
| Biometric app lock / encrypted token vault | haven, skerryssh, hermes-android | 🗺️ app |
| Host-key TOFU fingerprint confirm | haven, connectbot | ⚙️ (pinning confirm on first connect) |
| Multi-protocol connection profiles + host-key TOFU + SSH key mgmt | haven-ssh-client | ✅ `profile_create/list/update/delete/connect/disconnect` + `hostkey_verify/list` + `sshkey_generate/list/delete` + `mproto_status` (simulated transport, like `rd_*`; real SSH/SFTP layer can slot in) |
| OSC 52 clipboard / OSC 8 hyperlinks / OSC 9;777 notifications | haven, kmp-terminal-emulator | 🗺️ |
| Volume-key shortcuts, themes, pinch-zoom font | termux, jackpal ATE, termlib | 🗺️ app |
| Offline chat cache + optimistic sends | stream-chat-android | 🗺️ app |
| Image attachments (camera/picker) into agent prompt | remodex-android, hermes-android | 🗺️ |

## 6. Chat-channel control & notifications  *(telegram_claude-cli-telegram, whatsapp-claude-plugin, baileys, anotifier, marchat, soketi, happier, …)*

| Feature | Source repos | Status |
|---|---|---|
| Outbound notifications: Telegram/Discord/Email/Line/Slack/Mattermost | claude-threads (Mattermost), — | ✅ webhook channels incl. self-hosted Mattermost (`MATTERMOST_WEBHOOK_URL`) |
| **Two-way Telegram control** (sessions/say/approve/reject, allow-listed chats) | telegram_claude-cli-telegram, whatsapp-claude-plugin | ✅ `telegram_control.js` (env-gated) |
| WhatsApp two-way channel | baileys, whatsapp-web.js | ✅ `wa_*` channel surface (QR auth lifecycle, allowlist, command-prefix dispatch into real sessions, replies, history) — TS→ESM port + fixed unreachable `ready` state; real baileys transport remains roadmap |
| Per-chat-user allowlist + prompt-injection-safe approval | whatsapp-claude-plugin | ✅ (`TELEGRAM_ALLOW_CHAT_IDS`; approvals from chat map to proposals) |
| Rich notification payload (what the agent asked) | anotifier | ⚙️ partial (proposals carry summary) |
| Quiet hours / focus mode / priority tiers | marchat, shooter | ✅ `quiet_set` — off/notify/priority/silent with time windows (quiet_hours.js) |
| Lock-screen action buttons (approve/deny from push) | shooter, remote-control | 🗺️ app |
| Notification coalescing/dedupe + telemetry | shooter, anotifier | ✅ `notify_send`/`notify_stats`/`notify_bursts` — shooter brain (decision-first, dedupe window, per-project coalescing, idle gate, telemetry) feeding the channel registry; two latent bugs fixed |
| Pusher-style pub/sub channels + presence | soketi | ➖ (direct WS model fits better) |
| History replay on reconnect | marchat | ✅ chat transcript replay + terminal backfill |
| Voice transcription | — | ⚙️ (Whisper) |
| Voice assistant answering permission requests | happier | 🗺️ |
| Scheduler/cron from chat | kagora, telegram bridge | 🗺️ |

## 7. Service & platform  *(node-windows, pm2, mise, cockpit, openchamber, …)*

| Feature | Source repos | Status |
|---|---|---|
| One-liner installers (bash + PowerShell) | — | ⚙️ |
| Windows service + tray | node-windows | ⚙️ |
| Watchdog crash recovery | node-windows, pm2 | ⚙️ (service restart) + ✅ in-daemon `monitor_list`/`monitor_stats`/`monitor_history` + live `monitor_event` broadcasts (discovery/termination of node/claude/python processes); ported CJS→ESM |
| Keep-PC-awake while agents run (per-process assertion) | orca, LinkShell | ✅ `power_*` (`RH_AWAKE` auto/on/off) — rewritten to SetThreadExecutionState/caffeinate, **no global powercfg/pmset mutation** |
| Host stats cards (CPU/mem/uptime) | webmux, vmux, multimux | ✅ `stats` |
| Self auto-update | tailscale, rustdesk | 🗺️ |
| Hot config reload | frp | 🗺️ |
| Doctor/self-diagnosis command | whatsapp-claude-plugin, marchat | ✅ `doctor` → structured report (node, data dir, TLS, PTY, tmux, per-agent PATH checks with hints) |

---

## Wired in this pass (protocol summary)

New client → server: `share_create` · `share_join` · `share_list` · `share_revoke` ·
`stats` · `git_status` · `git_diff` · `git_log` · `git_branches` · `record_start` ·
`record_stop` · `record_list` · `record_get` · `tunnel_create` · `tunnel_close` ·
`tunnel_list` · `power_set` · `power_status` · `activity_list` · `resurrect_list` ·
`resume` (+ `attach` now accepts `since`) · `relay_connect` · `relay_disconnect` ·
`relay_status` · `relay_publish` · `relay_send` · `relay_host` · `relay_host_stop` ·
`tmux_list` · `tmux_create` · `tmux_kill` · `tmux_resize` · `tmux_keys` ·
`tmux_capture` · `render_digest` · `agent_list` · `agent_create` · `agent_start` ·
`agent_pause` · `agent_resume` · `agent_complete` · `agent_error` · `agent_stats` ·
`agent_say` · `agent_broadcast` · `lan_peers` · `lan_send` · `vnc_start` · `vnc_stop` · `vnc_status` · `vnc_frame` ·
`bastion_user_add` · `bastion_host_add` · `bastion_rule_add` · `bastion_access` ·
`bastion_session_start` · `bastion_session_end` · `bastion_sessions` · `bastion_stats` ·
`bastion_invite` · `bastion_invite_accept` · `sshserver_user_add` ·
`sshserver_session_create` · `sshserver_exec` · `sshserver_session_end` ·
`sshserver_sessions` · `sshserver_stats` · `profile_create` · `profile_list` ·
`profile_update` · `profile_delete` · `profile_connect` · `profile_disconnect` ·
`hostkey_verify` · `hostkey_list` · `sshkey_generate` · `sshkey_list` ·
`sshkey_delete` · `mproto_status`.

New server → client: `share_created` · `share_joined` · `share_list` · `share_revoked` ·
`stats` · `git_status` · `git_diff` · `git_log` · `git_branches` · `recording` ·
`record_list` · `record_get` · `tunnel_created` · `tunnel_closed` · `tunnel_list` ·
`power_status` · `activity` · `activity_list` · `resurrect_list` · `created {resumed}` —
plus `seq` on every `out` and `incremental` on `replay` · `relay_state` ·
`relay_message` (channel pub/sub + direct, `from` = relay peer id) · `relay_published` ·
`relay_sent` · `relay_host` · `tmux_list` · `tmux_created` · `tmux_killed` ·
`tmux_resized` · `tmux_keys_sent` · `tmux_capture` · `digest_render` ·
`agent_state` (live broadcasts on every fleet transition) · `agent_created` ·
`agent_error` · `agent_said` · `agent_broadcast_sent` · `lan_peers` · `lan_sent` · `vnc_started` · `vnc_stopped` · `vnc_status` · `vnc_frame_ok` ·
`vnc_event` · `bastion_user_added` · `bastion_user_list` · `bastion_host_added` ·
`bastion_host_list` · `bastion_rule_added` · `bastion_access` ·
`bastion_session_started` · `bastion_session_ended` · `bastion_sessions` ·
`bastion_stats` · `bastion_invite` · `bastion_invite_accepted` · `bastion_event` ·
`sshserver_user_added` · `sshserver_user_list` · `sshserver_session_created` ·
`sshserver_exec_ok` · `sshserver_session_ended` · `sshserver_sessions` ·
`sshserver_stats` · `sshserver_event` · `profile_created` · `profile_list` ·
`profile_updated` · `profile_deleted` · `profile_connected` · `profile_disconnected` ·
`hostkey_verify` · `hostkey_list` · `sshkey_generated` · `sshkey_list` ·
`sshkey_deleted` · `mproto_status` · `mproto_event`.

Relay protocol: daemon connects OUT to a relay (`relay://host:port`), subscribes to
`RH_RELAY_CHANNEL` (default `rh-<hostname>`), and bridges channel messages to every
authed WS client — a phone that joins the same channel on the same relay talks to the
daemon with zero inbound ports on the PC. The daemon can also host a relay itself
(`RH_RELAY_PORT`) so LAN peers relay through it. The relay echoes your own publishes
back (broadcast to all members) — distinguish by `from`/`relay_status.connId`.

Env knobs: `RH_QUIET_MS` (busy→quiet threshold), `RH_IDLE_KILL_MINUTES`,
`RH_AWAKE` (off/auto/on), `RH_CLI_PORT`, `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_ALLOW_CHAT_IDS` (two-way control), `POCKETDESK_DATA`,
`RH_RELAY_URL` (auto-connect outbound link at boot) + `RH_RELAY_CHANNEL`,
`RH_RELAY_PORT` (host an embedded relay).

Bugs fixed while wiring: plugin hooks lost `this` (logger/metrics/auth errored on
every event), auth plugin short-circuited the 4003 handshake contract, CLI server
crashed the daemon when its fixed port was taken, `SessionRecorder`/`TunnelManager`
were imported but never instantiated, keep-awake mutated global power settings,
`relay_server.js` and `terminal_renderer.js` were CJS in an ESM package (ported to ESM).

Connect pass (2026-09-10): `/pair` loopback gate rejected IPv4-mapped clients
(`::ffff:127.0.0.1`, Windows dual-stack sockets) — QR pairing 403'd from the same
machine; chat transcripts doubled the final assistant text (`finishTurn` re-appended
`last_agent_message` after the streaming deltas already carried it — now dedupes via
last-assistant prefix/contains check); the browser client orphaned message DOM nodes
on `chatreplay` (a replay arriving after `chatuser` re-appended the user bubble while
the original lingered — tracked nodes are now removed before the rebuild). Daemon
banner now prints the full token in dev and always advertises the loopback-gated
pairing URL (previously TLS-only).

Freebuff control plane + agent fleet + model selection (2026-09-10): new `fb_*` surface
(`fb_status`, `fb_config_list/get/set`, `fb_skill_list/get/run`, `fb_auth_status/logout`,
`fb_app_open/quit`) in `daemon/src/freebuff_control.js` — status of the real Freebuff
desktop install (running/exe/profile), allowlisted config view/edit with `.bak` backups,
skills from `~/.claude/skills` (view SKILL.md, run a skill as a real agent chat), auth
status (token never exposed) and logout-with-backup, app open/quit. Four new harness
manifests: antigravity, copilot, cline, zcode (registry install/detect + chat adapters
where CLI-supported). Model selection: manifests carry `chat.models` maps (claude
opus/sonnet/haiku, codex, opencode); `model_list` / `chat_model_set` pick a per-chat
model, resolved in `chat.js` to per-agent runtime args. Browser UI gained a Freebuff tab
(status cards, skills View/Run, config View/Edit, login controls) and a model picker in
the chat toolbar; the Android app gained a FreebuffScreen + model picker in ChatScreen
(`fb_*` + `model_list`/`chat_model_set` protocol support). Verified live: `fb_status`
reports the running app, 28 skills, 3 configs; model_list → [opus, sonnet, haiku] and
`chat_model_set` → `current: "opus"`. Full suite: 284 PASS, exit 0.

Known limits: Android FreebuffScreen is UI-complete but verified compile-only (no
instrumented tests); Freebuff auth store is OS-encrypted so `loggedIn` reflects
detectability, not session truth; AnyDesk-style full screen streaming remains on the
roadmap (the rd_*/vnc_* surfaces cover remote desktop scaffolding).

Off-LAN relay bridge (2026-09-10): the relay transport is now a real command
path, not just an event mirror. Remote peers publish `rhreq` envelopes
(`{rh:true, type:"rhreq", reqId, msg:{...protocol...}}`) on the daemon's
channel; the daemon timing-safe-validates the token (same as the /ws hello),
replays the inner message through the normal handle() path via a shim ws, and
pushes every response/broadcast back as `rhresp`/`rhpush`. Own echoes are
dropped (envelope loop guard). Hosting a relay (RH_RELAY_PORT) now also dials
itself over loopback so the bridge has channel membership — remote peers get
the daemon with zero extra config. Android app speaks `relay://host:port/channel`
natively (RelayLink.kt raw TCP client, rh envelope wrap in WsClient, rherr
surfacing, reconnect via existing backoff). Config: `relay.{url,channel,hostPort}`
persisted in config.json; pair-QR payload carries `r`/`c` relay fields. README
gained an Operations Manual (start, LAN/relay/Tailscale/port-forward modes,
security checklist). Tests: relay-bridge.test.mjs (9 checks, full 293 PASS);
live-verified against the running daemon on channel rh-legion.
