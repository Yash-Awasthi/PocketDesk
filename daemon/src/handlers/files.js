import * as sessions from "../sessions.js";
import { gitStatus, gitDiff, gitLog, gitBranches } from "../gitpanel.js";
import * as mentions from "../mentions.js";
import { listDir, readFileChunk, writeFileChunk, resolvePath, fileOp, searchFiles } from "../fs_ops.js";

export default function filesHandlers(ctx) {
  const { send } = ctx;
  return {
    async fs(ws, msg) {
      send(ws, listDir(msg.path, msg.hidden === true));
    },
    async fread(ws, msg) {
      send(ws, readFileChunk(msg.path, msg.offset));
    },
    async fwrite(ws, msg) {
      send(ws, writeFileChunk(msg));
    },
    async fs_op(ws, msg) {
      send(ws, await fileOp(msg));
    },
    async fs_search(ws, msg) {
      send(ws, await searchFiles(msg.path, msg.q));
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
    // ── @file mention in terminal session (agent-tmux-web pattern) ────
    async mention(ws, msg) {
      try {
        const ex = mentions.expand(String(msg.text ?? ""), msg.cwd || sessions.get(msg.id)?.cwd);
        send(ws, { type: "mention_expanded", ok: true, ...ex });
      } catch (e) {
        send(ws, { type: "mention_expanded", ok: false, error: e.message });
      }
    },
  };
}
