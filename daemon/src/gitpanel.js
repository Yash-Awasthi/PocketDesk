/**
 * Git Panel — inspect repos on the PC from the phone.
 *
 * Absorbed from ccpocket/vibego/orca/1code (phone-side git status/diff/log/branch).
 * Read-only: status, diff, log, branches. Mutating ops stay with the agent
 * (a chat session) — this panel never stages/commits/pushes.
 */

import { execFile } from "node:child_process";

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
          resolve({ ok: true, out: stdout.length > MAX_OUT ? stdout.slice(0, MAX_OUT) + "\n…[truncated]" : stdout });
        }
      },
    );
  });
}

export async function gitStatus(cwd) {
  const r = await git(cwd, ["status", "--porcelain=v1", "-b"]);
  if (!r.ok) return r;
  const head = r.out.split("\n")[0] || "";
  const branchMatch = head.match(/^## ([^.\s]+)(?:\.\.\.(\S+))?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
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
    commits: r.out.split("\n").filter(Boolean).map((l) => {
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
    branches: r.out.split("\n").filter(Boolean).map((l) => {
      const [name, current] = l.split("|");
      return { name: name.trim(), current: current.trim() === "*" };
    }),
  };
}
