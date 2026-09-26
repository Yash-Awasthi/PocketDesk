import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHUNK = 256 * 1024;

/**
 * Deepest existing ancestor resolved through symlinks, with the not-yet-
 * existing tail re-appended. A plain path.resolve leaves a link under $HOME
 * pointing anywhere on disk, which defeats the containment check below.
 */
function realResolve(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function resolvePath(p) {
  const resolved = realResolve(p && String(p).trim() ? path.resolve(String(p).replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir());
  // Security: block path traversal outside home, with an escape hatch for
  // the OS temp dir (tests and file-transfer staging legitimately live
  // there, and on Linux /tmp is NOT under home). ponytail: per-user tmp
  // roots if this ever runs multi-tenant.
  const home = realResolve(os.homedir());
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const allowed = resolved === home || resolved.startsWith(home + path.sep) ||
    resolved.startsWith(tmpRoot + path.sep) || path.dirname(resolved) === tmpRoot;
  if (!allowed) throw new Error("Path traversal not allowed");
  return resolved;
}

export function listDir(p, hidden = false) {
  let dir;
  try {
    dir = resolvePath(p);
  } catch (e) {
    return { type: "fs", error: e.message };
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { type: "fs", error: e.message };
  }
  const shown = entries.filter((e) => hidden || !e.name.startsWith("."));
  const items = shown
    .slice(0, 2000)
    .map((e) => {
      let size = null;
      let mtime = null;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        if (!e.isDirectory()) size = st.size;
        mtime = Math.round(st.mtimeMs);
      } catch {}
      return { name: e.name, dir: e.isDirectory(), size, mtime };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { type: "fs", path: dir, parent: path.dirname(dir), items, truncated: shown.length > items.length };
}

/** mkdir, rename and delete for the phone's file manager. Never overwrites an existing target. */
export async function fileOp(msg) {
  const op = String(msg.op || "");
  const reply = { type: "fs_result", op, path: msg.path };
  try {
    // Resolve only the parent: a rename or delete must act on a link itself, never on what it points to.
    const raw = String(msg.path || "").replace(/[\\/]+$/, "");
    const target = path.join(resolvePath(path.dirname(raw)), path.basename(raw));
    if (target === realResolve(os.homedir())) throw new Error("refusing to change the home folder itself");
    if (op === "mkdir") {
      if (fs.existsSync(target)) throw new Error("already exists");
      fs.mkdirSync(target, { recursive: true });
    } else if (op === "rename") {
      const to = resolvePath(msg.to);
      if (fs.existsSync(to)) throw new Error("a file with that name already exists");
      fs.renameSync(target, to);
      reply.to = msg.to;
    } else if (op === "delete") {
      const st = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!st) throw new Error("not found");
      if (st.isSymbolicLink()) fs.rmSync(target);
      else await removeToTrash(target);
    } else {
      throw new Error("unknown op " + op);
    }
    return { ...reply, ok: true };
  } catch (e) {
    return { ...reply, ok: false, error: e.message };
  }
}

/** Windows deletes go to the Recycle Bin so a mis-tap on the phone is recoverable. */
async function removeToTrash(target) {
  if (process.platform !== "win32" || process.env.RH_FS_NO_TRASH) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  const { execFile } = await import("node:child_process");
  const kind = fs.statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}($env:RH_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, RH_TRASH: target }, windowsHide: true, timeout: 60000 },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr).trim().split("\n")[0] || err.message)) : resolve()));
  });
  if (fs.existsSync(target)) throw new Error("could not move to the Recycle Bin");
}

const SKIP_DIRS = new Set(["node_modules", ".git", "AppData", "$Recycle.Bin", "__pycache__", ".venv", "build", "dist"]);

/** Case-insensitive name search below a folder, breadth first, so near matches come first. */
export async function searchFiles(p, q, limit = 200) {
  const needle = String(q || "").trim().toLowerCase();
  let root;
  try {
    root = resolvePath(p);
  } catch (e) {
    return { type: "fs_found", path: p, q, error: e.message, items: [] };
  }
  if (!needle) return { type: "fs_found", path: root, q, items: [] };
  const items = [];
  const queue = [root];
  let scanned = 0;
  while (queue.length && items.length < limit && scanned < 20000) {
    const dir = queue.shift();
    scanned++;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(needle)) {
        let size = null;
        if (!e.isDirectory()) try { size = (await fs.promises.stat(full)).size; } catch {}
        items.push({ path: full, name: e.name, dir: e.isDirectory(), size });
        if (items.length >= limit) break;
      }
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) queue.push(full);
    }
  }
  return { type: "fs_found", path: root, q, items, truncated: queue.length > 0 };
}

// Replies echo the requested path: the phone keys transfers by it, and the
// resolved path differs whenever a symlink or junction is involved.
export function readFileChunk(p, offset) {
  let file;
  try {
    file = resolvePath(p);
  } catch (e) {
    return { type: "fchunk", path: p, error: e.message };
  }
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { type: "fchunk", path: p, error: "not a file" };
    const start = Math.max(0, Number(offset) || 0);
    if (start >= st.size) return { type: "fchunk", path: p, size: st.size, data: "", eof: true };
    const len = Math.min(CHUNK, st.size - start);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return {
      type: "fchunk",
      path: p,
      offset: start,
      size: st.size,
      data: buf.toString("base64"),
      eof: start + len >= st.size,
    };
  } catch (e) {
    return { type: "fchunk", path: p, error: e.message };
  }
}

export function writeFileChunk(msg) {
  let file;
  try {
    file = resolvePath(msg.path);
  } catch (e) {
    return { type: "fwritten", path: msg.path, error: e.message };
  }
  const append = Boolean(msg.append);
  try {
    let base = 0;
    if (!append) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(0));
    } else if (fs.existsSync(file)) {
      base = fs.statSync(file).size;
    }
    const buf = Buffer.from(String(msg.data || ""), "base64");
    if (buf.length > 0) fs.appendFileSync(file, buf);
    return { type: "fwritten", path: msg.path, size: base + buf.length };
  } catch (e) {
    return { type: "fwritten", path: msg.path, error: e.message };
  }
}
