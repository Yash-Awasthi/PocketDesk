import * as sessions from "../sessions.js";
import * as portForward from "../port-forward.js";
import { gitStatus, gitDiff, gitLog, gitBranches } from "../gitpanel.js";
import { sendFiles, getLocalIPs } from "../lan_file_transfer.js";
import * as mentions from "../mentions.js";
import * as worktrees from "../worktrees.js";
import { listDir, readFileChunk, writeFileChunk, resolvePath } from "../fs_ops.js";

export default function filesHandlers(ctx) {
  const { send, tunnels, lanDiscovery, ensureLanDiscovery } = ctx;
  return {
    async forward_start(ws, msg) {
      const fw = portForward.start({ id: msg.id || "fwd" + Date.now(), localPort: msg.localPort, remoteHost: msg.remoteHost, remotePort: msg.remotePort });
      send(ws, { type: "forward_started", ...fw });
    },
    async forward_stop(ws, msg) {
      portForward.stop(msg.id);
      send(ws, { type: "forward_stopped", id: msg.id });
    },
    async forward_list(ws, msg) {
      send(ws, { type: "forward_list", items: portForward.list() });
    },
    async fs(ws, msg) {
      send(ws, listDir(msg.path));
    },
    async fread(ws, msg) {
      send(ws, readFileChunk(msg.path, msg.offset));
    },
    async fwrite(ws, msg) {
      send(ws, writeFileChunk(msg));
    },
    // ── Git panel (ccpocket/vibego: read-only repo inspection) ──
    async git_status(ws, msg) {
      send(ws, { type: "git_status", ...(await gitStatus(msg.cwd || sessions.get(msg.id)?.cwd)) });
    },
    async git_diff(ws, msg) {
      send(ws, { type: "git_diff", ...(await gitDiff(msg.cwd || sessions.get(msg.id)?.cwd)) });
    },
    async git_log(ws, msg) {
      send(ws, { type: "git_log", ...(await gitLog(msg.cwd || sessions.get(msg.id)?.cwd, msg.limit)) });
    },
    async git_branches(ws, msg) {
      send(ws, { type: "git_branches", ...(await gitBranches(msg.cwd || sessions.get(msg.id)?.cwd)) });
    },
    // ── Tunnels (frp/bore-lite: reach PC-local services from the phone) ──
    async tunnel_create(ws, msg) {
      try {
        const id = await tunnels.createTunnel(Number(msg.localPort), Number(msg.remotePort), { bindAll: Boolean(msg.bindAll) });
        send(ws, { type: "tunnel_created", id, localPort: msg.localPort, remotePort: msg.remotePort });
      } catch (e) {
        send(ws, { type: "tunnel_created", ok: false, error: e.message, localPort: msg.localPort, remotePort: msg.remotePort });
      }
    },
    async tunnel_close(ws, msg) {
      tunnels.closeTunnel(msg.id);
      send(ws, { type: "tunnel_closed", id: msg.id });
    },
    async tunnel_list(ws, msg) {
      send(ws, { type: "tunnel_list", items: tunnels.listTunnels() });
    },
    // ── LAN file transfer (lanlink: LocalSend v2 + UDP discovery) ─────────
    async lan_peers(ws, msg) {
      ensureLanDiscovery();
      send(ws, { type: "lan_peers", active: true, peers: lanDiscovery.getPeers(), ips: getLocalIPs() });
    },
    async lan_send(ws, msg) {
      try {
        const result = await sendFiles(String(msg.ip), Number(msg.port), [resolvePath(msg.path)]);
        send(ws, { type: "lan_sent", ok: true, ...result, peer: msg.ip });
      } catch (e) {
        send(ws, { type: "lan_sent", ok: false, peer: msg.ip, error: e.message });
      }
    },
    // ── @file mention in terminal session (agent-tmux-web pattern) ────
    async mention(ws, msg) {
      try {
        const ex = mentions.expand(String(msg.text ?? ""), msg.cwd || sessions.get(msg.id)?.cwd);
        send(ws, { type: "mention_expanded", ok: true, ...ex });
      } catch (e) {
        send(ws, { type: "mention_expanded", ok: false, error: e.message });
      }
    },
    // ── Worktree isolation (vmux/orca/ccpocket/nimbalyst) ─────────────
    async wt_create(ws, msg) {
      const r = await worktrees.createWorktree({ repo: msg.repo, name: msg.name, branch: msg.branch === undefined ? undefined : msg.branch, base: msg.base });
      send(ws, { type: "worktree_created", ...r });
    },
    async wt_list(ws, msg) {
      const r = await worktrees.listWorktrees(String(msg.repo ?? ""));
      send(ws, { type: "worktree_list", ...r, tracked: worktrees.listTracked() });
    },
    async wt_remove(ws, msg) {
      const r = await worktrees.removeWorktree(String(msg.repo ?? ""), String(msg.path ?? ""), { force: Boolean(msg.force) });
      send(ws, { type: "worktree_removed", ...r });
    },
  };
}
