// File manager operations, called directly without a daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";
import { listDir, fileOp, searchFiles, readFileChunk, writeFileChunk, resolvePath } from "../src/fs_ops.js";
import { zipFolder, thumbnail, dispose } from "../src/file_extras.js";
import { execFileSync } from "node:child_process";

process.env.RH_FS_NO_TRASH = "1";
// Real path: on macOS os.tmpdir() is /var/..., a symlink the daemon resolves to /private/var/...
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rh-fsops-")));
// Concatenate instead of path.join: path.join collapses "..", and the traversal
// checks below need the literal ".." segments to reach fileOp.
const at = (...p) => [tmp, ...p].join(path.sep);

try {
  fs.writeFileSync(at("a.txt"), "hello");
  fs.writeFileSync(at(".hidden"), "x");

  let l = listDir(tmp);
  check("listing hides dotfiles by default", !l.items.some((i) => i.name === ".hidden"));
  check("listing carries size and mtime", l.items.find((i) => i.name === "a.txt")?.size === 5 && l.items[0].mtime > 0);
  check("listing shows dotfiles on request", listDir(tmp, true).items.some((i) => i.name === ".hidden"));

  let r = await fileOp({ op: "mkdir", path: at("sub", "deep") });
  check("mkdir creates nested folders", r.ok && fs.statSync(at("sub", "deep")).isDirectory());
  r = await fileOp({ op: "mkdir", path: at("sub") });
  check("mkdir refuses an existing folder", !r.ok);

  fs.writeFileSync(at("b.txt"), "b");
  r = await fileOp({ op: "rename", path: at("a.txt"), to: at("b.txt") });
  check("rename never overwrites", !r.ok && fs.readFileSync(at("b.txt"), "utf8") === "b");
  r = await fileOp({ op: "rename", path: at("a.txt"), to: at("sub", "moved.txt") });
  check("rename moves a file", r.ok && fs.existsSync(at("sub", "moved.txt")) && !fs.existsSync(at("a.txt")));

  r = await searchFiles(tmp, "MOVED");
  check("search is case-insensitive and recursive", r.items.length === 1 && r.items[0].path === at("sub", "moved.txt"));
  r = await searchFiles(tmp, "");
  check("empty search returns nothing", r.items.length === 0);

  // A link to a folder is removed without touching what it points to.
  fs.mkdirSync(at("real"));
  fs.writeFileSync(at("real", "keep.txt"), "k");
  fs.symlinkSync(at("real"), at("link"), "junction");
  r = await fileOp({ op: "delete", path: at("link") });
  check("deleting a link keeps its target", r.ok && !fs.existsSync(at("link")) && fs.existsSync(at("real", "keep.txt")));

  r = await fileOp({ op: "delete", path: at("sub") });
  check("delete removes a folder", r.ok && !fs.existsSync(at("sub")));
  r = await fileOp({ op: "delete", path: os.homedir() });
  check("the home folder itself cannot be deleted", !r.ok);
  r = await fileOp({ op: "delete", path: path.parse(tmp).root + "Windows" });
  check("paths outside home are refused", !r.ok && /traversal/.test(r.error));
  r = await fileOp({ op: "chmod", path: at("b.txt") });
  check("unknown ops are refused", !r.ok);

  // Traversal and path-shape hardening.
  r = await fileOp({ op: "delete", path: at("sub") + path.sep + ".." + path.sep + ".." });
  check("traversal: final .. component is refused", !r.ok && /traversal/i.test(r.error) && fs.existsSync(tmp) && fs.existsSync(at("b.txt")));

  // A path escaping through mid-path ".." must land outside both allowed roots.
  const outsideBase = process.platform === "win32" ? path.join("C:\\", "Users", "Public") : "/var/tmp";
  const sentinel = path.join(outsideBase, "rh-escape-sentinel-" + process.pid);
  fs.mkdirSync(sentinel, { recursive: true });
  try {
    const midEscape = at("sub") + path.sep + ".." + path.sep + path.relative(tmp, sentinel);
    r = await fileOp({ op: "delete", path: midEscape });
    check("traversal: mid-path .. escape is refused", !r.ok && /traversal/i.test(r.error) && fs.existsSync(sentinel));
  } finally {
    fs.rmSync(sentinel, { recursive: true, force: true });
  }

  fs.mkdirSync(at("sub"), { recursive: true });
  r = await fileOp({ op: "rename", path: at("sub") + path.sep + ".." + path.sep + "b.txt", to: at("b2.txt") });
  check("traversal: benign .. inside tmp still works", r.ok && fs.existsSync(at("b2.txt")) && !fs.existsSync(at("b.txt")));
  r = await fileOp({ op: "rename", path: at("b2.txt"), to: at("b.txt") });
  check("traversal: renaming the file back works", r.ok);

  // A link under the temp root that points outside every allowed root.
  const escapeTarget = process.platform === "win32" ? "C:\\Windows" : "/etc";
  const escapeFile = process.platform === "win32" ? "win.ini" : "hosts";
  const probe = "pd-probe-" + process.pid + ".txt";
  fs.symlinkSync(escapeTarget, at("escape"), "junction");
  try {
    let e = readFileChunk(at("escape", escapeFile), 0);
    check("symlink escape: reading outside is refused", /traversal/i.test(String(e.error || "")));
    e = writeFileChunk({ path: at("escape", probe), data: "aGk=" });
    check("symlink escape: writing outside is refused", /traversal/i.test(String(e.error || "")));
    e = await fileOp({ op: "delete", path: at("escape", escapeFile) });
    check("symlink escape: deleting outside is refused", !e.ok && /traversal/i.test(String(e.error || "")));
    e = await fileOp({ op: "rename", path: at("escape", escapeFile), to: at("escape", "renamed.ini") });
    check("symlink escape: renaming outside is refused", !e.ok && /traversal/i.test(String(e.error || "")));
    check("symlink escape: target untouched and no probe written",
      fs.existsSync(path.join(escapeTarget, escapeFile)) && !fs.existsSync(path.join(escapeTarget, probe)));
  } finally {
    try { fs.rmSync(at("escape"), { force: true }); } catch { fs.unlinkSync(at("escape")); }
  }

  if (process.platform === "win32") {
    const plain = readFileChunk(at("b.txt"), 0);
    let q = readFileChunk("\\\\?\\" + at("b.txt"), 0);
    check("\\\\?\\ prefix: inside tmp reads the same file", !q.error && q.data === plain.data);
    q = readFileChunk("\\\\?\\C:\\Windows\\win.ini", 0);
    check("\\\\?\\ prefix: outside path is refused", /traversal/i.test(String(q.error || "")));
    q = readFileChunk("\\\\.\\" + at("b.txt"), 0);
    check("\\.\\ prefix: inside tmp reads the same file", !q.error && q.data === plain.data);
    q = readFileChunk("\\\\.\\C:\\Windows\\win.ini", 0);
    check("\\.\\ prefix: outside path is refused", /traversal/i.test(String(q.error || "")));

    for (const name of ["CON", "NUL.txt", "COM1", "LPT9.log", "CLOCK$"]) {
      const m = await fileOp({ op: "mkdir", path: at(name) });
      check("reserved device name refused: " + name, !m.ok && /reserved/i.test(String(m.error || "")) && !fs.existsSync(at(name)));
    }
  }

  const rt = writeFileChunk({ path: at("roundtrip.txt"), data: Buffer.from("roundtrip").toString("base64") });
  const rtb = readFileChunk(at("roundtrip.txt"), 0);
  check("round-trip: plain write and read inside tmp still works",
    !rt.error && Buffer.from(rtb.data || "", "base64").toString("utf8") === "roundtrip");

  fs.mkdirSync(at("pack", "sub"), { recursive: true });
  fs.writeFileSync(at("pack", "sub", "x.txt"), "zip me");
  const z = await zipFolder(at("pack"));
  check("a folder zips into a readable archive", z.ok && z.size > 0 && fs.readFileSync(z.zip).subarray(0, 2).toString() === "PK");
  if (z.zip) fs.rmSync(z.zip, { force: true });
  check("zipping a file is refused", !(await zipFolder(at("b.txt"))).ok);
  if (process.platform === "win32") {
    const png = at("pic.png");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -A System.Drawing; (New-Object System.Drawing.Bitmap 640,480).Save('${png}')`]);
    const t = await thumbnail(png, 100);
    check("an image gets a JPEG thumbnail", t.ok && Buffer.from(t.jpeg, "base64")[0] === 0xff);
    check("the image is not left locked", (() => { try { fs.rmSync(png); return true; } catch { return false; } })());
    check("non-images get no thumbnail", !(await thumbnail(at("b.txt"))).ok);
    dispose();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
