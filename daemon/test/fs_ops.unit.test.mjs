// File manager operations, called directly without a daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";
import { listDir, fileOp, searchFiles } from "../src/fs_ops.js";

process.env.RH_FS_NO_TRASH = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fsops-"));
const at = (...p) => path.join(tmp, ...p);

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
