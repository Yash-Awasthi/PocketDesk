/**
 * Installed-application discovery — what the phone picks from when the tool it
 * wants has no manifest.
 *
 * GUI applications come from the platform's own index (Start Menu shortcuts,
 * /Applications bundles, .desktop entries) and CLI tools from PATH, so nothing
 * has to be declared ahead of time. The scan reads hundreds of directories, so
 * the result is cached until a caller asks for a refresh.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
// Start Menu folders are mostly these; none of them is a tool to launch.
const JUNK = /uninstall|readme|release notes|documentation|website|home page|license|changelog|^help$|^docs?$/i;

function walk(dir, match, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) walk(p, match, depth - 1, out);
    } else if (match(e.name)) {
      out.push(p);
    }
  }
}

/**
 * Name and launch command of a freedesktop .desktop entry, or null when the
 * entry is hidden or describes no command.
 */
function readDesktopEntry(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let name = "";
  let exec = "";
  let hidden = false;
  let groups = 0;
  for (const line of text.split(/\r?\n/)) {
    // Groups after the first are per-action launches, not the app's own.
    if (line.startsWith("[") && ++groups > 1) break;
    if (!name && line.startsWith("Name=")) name = line.slice(5).trim();
    if (!exec && line.startsWith("Exec=")) exec = line.slice(5).trim();
    if (line === "NoDisplay=true" || line === "Hidden=true" || line === "Terminal=true") hidden = true;
  }
  if (!name || !exec || hidden) return null;
  // %U, %F and friends are placeholders the launcher substitutes; the folder
  // argument takes their place.
  const bin = exec.replace(/%[a-zA-Z]/g, "").trim().split(/\s+/)[0];
  return bin ? { name, path: bin, kind: "gui" } : null;
}

function guiApps() {
  const out = [];
  if (IS_WIN) {
    const roots = [
      path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    ];
    const links = [];
    for (const r of roots) walk(r, (n) => n.toLowerCase().endsWith(".lnk"), 4, links);
    for (const p of links) {
      const name = path.basename(p, path.extname(p));
      if (!JUNK.test(name)) out.push({ name, path: p, kind: "gui" });
    }
  } else if (process.platform === "darwin") {
    for (const r of ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")]) {
      let entries;
      try {
        entries = fs.readdirSync(r);
      } catch {
        continue;
      }
      for (const n of entries) if (n.endsWith(".app")) out.push({ name: n.slice(0, -4), path: path.join(r, n), kind: "gui" });
    }
  } else {
    const files = [];
    for (const r of ["/usr/share/applications", "/usr/local/share/applications", path.join(os.homedir(), ".local/share/applications")]) {
      walk(r, (n) => n.endsWith(".desktop"), 2, files);
    }
    for (const f of files) {
      const d = readDesktopEntry(f);
      if (d) out.push(d);
    }
  }
  return out;
}

function cliTools() {
  const out = [];
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";").filter(Boolean) : null;
  const seen = new Set();
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      let name = e.name;
      if (exts) {
        const ext = path.extname(name).toLowerCase();
        if (!exts.includes(ext)) continue;
        name = name.slice(0, -ext.length);
      } else {
        try {
          fs.accessSync(full, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      // Earlier PATH entries win, the same way the shell resolves a name.
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, path: full, kind: "cli" });
    }
  }
  return out;
}

let cache = null;

export function discover({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const apps = [];
  const seen = new Set();
  for (const a of [...guiApps(), ...cliTools()]) {
    const key = `${a.kind}:${a.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(a);
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = apps;
  return apps;
}

/**
 * Matches for a search box. The full scan runs into the thousands on a normal
 * machine, so the phone asks for a slice rather than the whole index.
 */
export function search(q = "", limit = 200) {
  const needle = String(q).trim().toLowerCase();
  const apps = discover();
  return (needle ? apps.filter((a) => a.name.toLowerCase().includes(needle)) : apps).slice(0, limit);
}

/**
 * The discovered entry for an absolute path, or null. Callers launch only what
 * this returns: a client-supplied path reaches a shell (`cmd /c start`, the
 * PTY's `cmd /c`), so an arbitrary string would be a command injection.
 */
export function find(p) {
  if (!p) return null;
  const want = IS_WIN ? String(p).toLowerCase() : String(p);
  return discover().find((a) => (IS_WIN ? a.path.toLowerCase() : a.path) === want) || null;
}
