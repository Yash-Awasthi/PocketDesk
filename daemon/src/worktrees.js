/**
 * Worktrees — git worktree-per-agent isolation.
 *
 * Absorbed from vmux / orca / ccpocket / nimbalyst (run sessions in separate
 * git worktrees so parallel agents never trample each other's working tree):
 * create/list/remove worktrees of a repo, and start a chat or terminal
 * session with its cwd set to the worktree.
 */

import { execFile } from "node:child_process";
import path from "node:path";

const TIMEOUT_MS = 15_000;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message).slice(0, 500) });
      else resolve({ ok: true, out: stdout });
    });
  });
}

const worktrees = new Map(); // id -> { id, repo, path, branch, createdAt }

/**
 * Create a worktree at <repo>/../<repo>-wt-<name> on a new branch (or an
 * existing one). Returns { ok, worktree } or { ok:false, error }.
 */
export async function createWorktree({ repo, name, branch, base }) {
  if (!repo || !name) return { ok: false, error: "repo and name required" };
  const wtBranch = branch || `wt-${name}`;
  // Resolve so '..' segments collapse — otherwise 'X/daemon/..' produces the
  // sibling 'X/..-wt-name' next to the daemon dir instead of next to the repo.
  const wtPath = path.resolve(String(repo), "..", `wt-${name}`);
  const args = ["worktree", "add"];
  if (branch !== null) args.push("-b", wtBranch);
  args.push(wtPath, ...(base ? [base] : []));
  const r = await git(repo, args);
  if (!r.ok) {
    // Branch already checked out elsewhere / exists — retry without -b.
    const r2 = await git(repo, ["worktree", "add", wtPath, base || wtBranch]);
    if (!r2.ok) return { ok: false, error: r2.error };
  }
  const wt = {
    id: "wt" + (worktrees.size + 1) + "-" + name,
    repo: path.resolve(String(repo)),
    path: wtPath,
    branch: branch === null ? (base || wtBranch) : wtBranch,
    createdAt: Date.now(),
  };
  worktrees.set(wt.id, wt);
  return { ok: true, worktree: wt };
}

export async function listWorktrees(repo) {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return { ok: false, error: r.error };
  const items = [];
  let cur = {};
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) cur.path = path.resolve(line.slice(9));
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "") {
      if (cur.path) items.push(cur);
      cur = {};
    }
  }
  if (cur.path) items.push(cur);
  return { ok: true, items };
}

export async function removeWorktree(repo, rawPath, { force = false } = {}) {
  const p = path.resolve(String(rawPath));
  const r = await git(repo, ["worktree", "remove", p, ...(force ? ["--force"] : [])]);
  if (!r.ok) return r;
  for (const [id, wt] of worktrees) if (path.resolve(wt.path) === p) worktrees.delete(id);
  return { ok: true };
}

export function listTracked() {
  return [...worktrees.values()];
}

export function getTracked(id) {
  return worktrees.get(id) ?? null;
}
