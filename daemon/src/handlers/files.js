import path from "node:path";
import * as sessions from "../sessions.js";
import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranches,
  stage,
  unstage,
  commit,
  createBranch,
  resolveRepoPaths,
} from "../gitpanel.js";
import * as mentions from "../mentions.js";
import * as proposals from "../proposals.js";
import { listDir, readFileChunk, writeFileChunk, fileOp, searchFiles } from "../fs_ops.js";
import { zipFolder, thumbnail } from "../file_extras.js";

// A phone decision usually arrives within seconds; five minutes holds a slow one.
const WAIT_MS = 280_000;
const SUMMARY_LIST_MAX = 100;

/** msg.paths may be an array or a single string; blank entries are not paths. */
function pathList(paths) {
  const list = Array.isArray(paths) ? paths : paths == null ? [] : [paths];
  return list.map((p) => String(p ?? "")).filter((p) => p.trim().length > 0);
}

export default function filesHandlers(ctx) {
  const { send } = ctx;

  /** Create the proposal, wait for the phone, and tell it why when it said no. */
  async function gated(ws, type, msg, summary, detail) {
    const p = proposals.create({
      type: "command_execute",
      summary,
      detail,
      sessionId: msg.sessionId || msg.id || "unknown",
    });
    const { status } = await proposals.waitForDecision(p.id, WAIT_MS);
    if (status === "approved") return true;
    send(ws, {
      type,
      ok: false,
      denied: status === "rejected",
      expired: status === "expired",
      error: status === "rejected" ? "denied on the phone" : "approval expired",
    });
    return false;
  }

  return {
    async fs(ws, msg) {
      // rid marks a listing asked for by the phone's Files app, apart from the screen it is browsing.
      send(
        ws,
        msg.rid != null
          ? { ...listDir(msg.path, msg.hidden === true), rid: msg.rid }
          : listDir(msg.path, msg.hidden === true),
      );
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
    async fs_zip(ws, msg) {
      send(ws, await zipFolder(msg.path));
    },
    async fs_thumb(ws, msg) {
      send(ws, await thumbnail(msg.path, msg.size));
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
    // ── Git panel mutations, each gated on a phone approval ──
    async git_stage(ws, msg) {
      const cwd = msg.cwd || sessions.get(msg.id)?.cwd;
      if (!cwd) {
        send(ws, { type: "git_stage", ok: false, error: "no repository path" });
        return;
      }
      const paths = pathList(msg.paths);
      if (paths.length === 0) {
        send(ws, { type: "git_stage", ok: false, error: "no paths given" });
        return;
      }
      const repo = await resolveRepoPaths(cwd, paths);
      if (!repo.ok) {
        send(ws, { type: "git_stage", ok: false, error: repo.error });
        return;
      }
      const listed = paths.join(" ");
      const short = listed.length > SUMMARY_LIST_MAX ? listed.slice(0, SUMMARY_LIST_MAX) + "…" : listed;
      const ok = await gated(ws, "git_stage", msg, `git stage ${short} in ${path.basename(cwd)}`, {
        cwd,
        op: "stage",
        args: { paths },
      });
      if (!ok) return;
      const result = await stage(cwd, paths);
      if (!result.ok) {
        send(ws, { type: "git_stage", ok: false, error: result.error });
        return;
      }
      send(ws, { ...result, type: "git_stage", ok: true, status: await gitStatus(cwd) });
    },
    async git_unstage(ws, msg) {
      const cwd = msg.cwd || sessions.get(msg.id)?.cwd;
      if (!cwd) {
        send(ws, { type: "git_unstage", ok: false, error: "no repository path" });
        return;
      }
      const paths = pathList(msg.paths);
      if (paths.length === 0) {
        send(ws, { type: "git_unstage", ok: false, error: "no paths given" });
        return;
      }
      const repo = await resolveRepoPaths(cwd, paths);
      if (!repo.ok) {
        send(ws, { type: "git_unstage", ok: false, error: repo.error });
        return;
      }
      const listed = paths.join(" ");
      const short = listed.length > SUMMARY_LIST_MAX ? listed.slice(0, SUMMARY_LIST_MAX) + "…" : listed;
      const ok = await gated(ws, "git_unstage", msg, `git unstage ${short} in ${path.basename(cwd)}`, {
        cwd,
        op: "unstage",
        args: { paths },
      });
      if (!ok) return;
      const result = await unstage(cwd, paths);
      if (!result.ok) {
        send(ws, { type: "git_unstage", ok: false, error: result.error });
        return;
      }
      send(ws, { ...result, type: "git_unstage", ok: true, status: await gitStatus(cwd) });
    },
    async git_commit(ws, msg) {
      const cwd = msg.cwd || sessions.get(msg.id)?.cwd;
      if (!cwd) {
        send(ws, { type: "git_commit", ok: false, error: "no repository path" });
        return;
      }
      const message = String(msg.message ?? "").trim();
      if (!message) {
        send(ws, { type: "git_commit", ok: false, error: "commit message is empty" });
        return;
      }
      const ok = await gated(
        ws,
        "git_commit",
        msg,
        `git commit in ${path.basename(cwd)}: ${message.slice(0, 80)}`,
        { cwd, op: "commit", args: { message } },
      );
      if (!ok) return;
      const result = await commit(cwd, message);
      if (!result.ok) {
        send(ws, { type: "git_commit", ok: false, error: result.error });
        return;
      }
      send(ws, {
        ...result,
        type: "git_commit",
        ok: true,
        status: await gitStatus(cwd),
        log: await gitLog(cwd, 5),
      });
    },
    async git_branch_create(ws, msg) {
      const cwd = msg.cwd || sessions.get(msg.id)?.cwd;
      if (!cwd) {
        send(ws, { type: "git_branch_create", ok: false, error: "no repository path" });
        return;
      }
      const name = String(msg.name ?? "").trim();
      if (!name) {
        send(ws, { type: "git_branch_create", ok: false, error: "branch name is empty" });
        return;
      }
      // Existence is checked only once approved: naming an existing branch is not an error yet.
      const ok = await gated(
        ws,
        "git_branch_create",
        msg,
        `git branch create ${name} in ${path.basename(cwd)}`,
        { cwd, op: "branch_create", args: { name } },
      );
      if (!ok) return;
      const result = await createBranch(cwd, name);
      if (!result.ok) {
        send(ws, { type: "git_branch_create", ok: false, error: result.error });
        return;
      }
      send(ws, {
        ...result,
        type: "git_branch_create",
        ok: true,
        status: await gitStatus(cwd),
        branches: await gitBranches(cwd),
      });
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
