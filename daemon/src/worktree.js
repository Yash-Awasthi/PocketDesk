// One git worktree per session: the agent works on its own branch beside the repo, never in the user's checkout.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const taken = (root, branch) => {
  try { git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); return true; } catch { return false; }
};

/** Creates <repo>-<name> beside the repo that holds `dir`, on branch pocketdesk/<name>, and returns its path. */
export function add(dir, name) {
  let root;
  try { root = path.resolve(git(dir, ["rev-parse", "--show-toplevel"])); } catch { throw new Error(`not a git repository: ${dir}`); }
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  for (let i = 1; ; i++) {
    const n = i === 1 ? slug : `${slug}-${i}`;
    const wt = path.join(path.dirname(root), `${path.basename(root)}-${n}`);
    if (fs.existsSync(wt) || taken(root, `pocketdesk/${n}`)) continue;
    git(root, ["worktree", "add", "-q", "-b", `pocketdesk/${n}`, wt]);
    return wt;
  }
}
