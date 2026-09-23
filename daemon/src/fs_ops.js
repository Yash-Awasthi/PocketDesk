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

export function listDir(p) {
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
  const items = entries
    .filter((e) => !e.name.startsWith("."))
    .slice(0, 500)
    .map((e) => {
      let size = null;
      if (!e.isDirectory()) {
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {}
      }
      return { name: e.name, dir: e.isDirectory(), size };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { type: "fs", path: dir, parent: path.dirname(dir), items };
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
