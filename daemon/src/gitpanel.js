/**
 * Git Panel — inspect and edit repos on the PC from the phone.
 *
 * Absorbed from ccpocket/vibego/orca/1code (phone-side git status/diff/log/branch).
 * Read ops: status, diff, log, branches. Gated mutations: stage, unstage, commit,
 * branch create — the phone must approve each one before it touches the repo.
 * No push, fetch, pull, remote or any other network operation lives here.
 */

import { execFile } from "node:child_process";
import path from "node:path";

const TIMEOUT_MS = 10_000;
const MAX_OUT = 64 * 1024;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: (stderr || err.message).slice(0, 500) });
        } else {
          resolve({
            ok: true,
            out: stdout.length > MAX_OUT ? stdout.slice(0, MAX_OUT) + "\n…[truncated]" : stdout,
          });
        }
      },
    );
  });
}

/** Same runner as `git`, but keeps the raw exit code (0 vs 1 both mean "ran fine"). */
function gitCode(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
          error: err ? (stderr || err.message).slice(0, 500) : null,
        });
      },
    );
  });
}

/**
 * Resolve requested paths against the repo root, refusing anything that leaves it.
 * Shared with the handlers so they can reject a bad path before proposing it.
 */
export async function resolveRepoPaths(cwd, paths) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p ?? ""))
    .filter((p) => p.trim().length > 0);
  if (list.length === 0) return { ok: false, error: "no paths given" };
  const rootR = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootR.ok) return { ok: false, error: rootR.error };
  const root = rootR.out.trim();
  const abs = [];
  for (const p of list) {
    const a = path.resolve(cwd, p);
    const rel = path.relative(root, a);
    if (rel === "") {
      return { ok: false, error: "refusing the repository root; name files, not the repo" };
    }
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
      return { ok: false, error: `path is outside the repository: ${a}` };
    }
    abs.push(a);
  }
  return { ok: true, root, paths: abs };
}

export async function gitStatus(cwd) {
  const r = await git(cwd, ["status", "--porcelain=v1", "-b"]);
  if (!r.ok) return r;
  const head = r.out.split("\n")[0] || "";
  const branchMatch = head.match(
    /^## ([^.\s]+)(?:\.\.\.(\S+))?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/,
  );
  const files = r.out
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => ({ x: l.slice(0, 2).trim(), path: l.slice(3).trim() }));
  return {
    ok: true,
    branch: branchMatch?.[1] || head.replace(/^##\s*/, "") || null,
    upstream: branchMatch?.[2] || null,
    ahead: Number(branchMatch?.[3]) || 0,
    behind: Number(branchMatch?.[4]) || 0,
    files,
  };
}

export async function gitDiff(cwd) {
  const r = await git(cwd, ["--no-pager", "diff", "HEAD"]);
  return r;
}

export async function gitLog(cwd, limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const r = await git(cwd, ["--no-pager", "log", `--max-count=${n}`, "--pretty=format:%h|%an|%ar|%s"]);
  if (!r.ok) return r;
  return {
    ok: true,
    commits: r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, author, when, ...subject] = l.split("|");
        return { hash, author, when, subject: subject.join("|") };
      }),
  };
}

export async function gitBranches(cwd) {
  const r = await git(cwd, ["branch", "--all", "--format=%(refname:short)|%(HEAD)"]);
  if (!r.ok) return r;
  return {
    ok: true,
    branches: r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, current] = l.split("|");
        return { name: name.trim(), current: current.trim() === "*" };
      }),
  };
}

export async function stage(cwd, paths) {
  const resolved = await resolveRepoPaths(cwd, paths);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return git(cwd, ["add", "--", ...resolved.paths]);
}

export async function unstage(cwd, paths) {
  const resolved = await resolveRepoPaths(cwd, paths);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return git(cwd, ["restore", "--staged", "--", ...resolved.paths]);
}

export async function commit(cwd, message) {
  const msg = String(message ?? "").trim();
  if (!msg) return { ok: false, error: "commit message is empty" };
  const staged = await gitCode(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { ok: false, error: "nothing staged to commit" };
  if (staged.code !== 1) return { ok: false, error: staged.error || "git diff --cached failed" };
  return git(cwd, ["commit", "-m", msg]);
}

export async function createBranch(cwd, name) {
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, error: "branch name is empty" };
  const valid = await gitCode(cwd, ["check-ref-format", "--branch", n]);
  if (valid.code !== 0) return { ok: false, error: "invalid branch name: " + n };
  const exists = await gitCode(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${n}`]);
  if (exists.code === 0) return { ok: false, error: "branch already exists: " + n };
  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.ok) return { ok: false, error: status.error };
  if (status.out.trim())
    return { ok: false, error: "working tree has uncommitted changes; commit or stash first" };
  return git(cwd, ["switch", "-c", n]);
}
