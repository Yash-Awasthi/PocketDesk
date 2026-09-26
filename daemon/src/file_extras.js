// File manager extras: a folder packed as a .zip for download, and small image thumbnails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { PsHelper } from "./desktop_capture.js";
import { resolvePath } from "./fs_ops.js";

const IS_WIN = process.platform === "win32";
const ZIP_DIR = path.join(os.tmpdir(), "pocketdesk-zips");
const ZIP_TTL_MS = 60 * 60 * 1000;
const THUMB_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;

/** Packs a folder into a .zip under the temp dir, which fread can serve; resolves { ok, zip, size }. */
export async function zipFolder(p) {
  let dir;
  try {
    dir = resolvePath(p);
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a folder");
  } catch (e) {
    return { type: "fs_zip", path: p, ok: false, error: e.message };
  }
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  for (const f of fs.readdirSync(ZIP_DIR)) {
    const full = path.join(ZIP_DIR, f);
    try { if (Date.now() - fs.statSync(full).mtimeMs > ZIP_TTL_MS) fs.rmSync(full, { force: true }); } catch {}
  }
  const zip = path.join(ZIP_DIR, `${path.basename(dir) || "folder"}-${Date.now()}.zip`);
  // Windows 10+ ships bsdtar, which writes zip with -a; elsewhere the zip command does.
  const [bin, args] = IS_WIN
    ? [path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", zip, "-C", path.dirname(dir), path.basename(dir)]]
    : ["zip", ["-r", "-q", zip, path.basename(dir)]];
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: path.dirname(dir), windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (err || !fs.existsSync(zip)) {
        return resolve({ type: "fs_zip", path: p, ok: false, error: String(stderr || err?.message || "zip failed").trim().split("\n")[0] });
      }
      resolve({ type: "fs_zip", path: p, ok: true, zip, size: fs.statSync(zip).size });
    });
  });
}

// One PowerShell process serves every thumbnail, so a folder of photos does not spawn one each.
const THUMB_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { continue }
  if ($cmd.op -eq 'ping') { Reply @{ id = $cmd.id; ok = $true }; continue }
  try {
    $src = New-Object System.IO.MemoryStream (,[System.IO.File]::ReadAllBytes($cmd.path))
    $img = [System.Drawing.Image]::FromStream($src)
    $s = [Math]::Min(1.0, $cmd.size / [Math]::Max($img.Width, $img.Height))
    $w = [Math]::Max(1, [int]($img.Width * $s)); $h = [Math]::Max(1, [int]($img.Height * $s))
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.DrawImage($img, 0, 0, $w, $h)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    Reply @{ id = $cmd.id; ok = $true; jpeg = [Convert]::ToBase64String($ms.ToArray()) }
    $g.Dispose(); $bmp.Dispose(); $img.Dispose(); $ms.Dispose(); $src.Dispose()
  } catch { Reply @{ id = $cmd.id; ok = $false; error = $_.Exception.Message } }
}
`;
let thumbHelper = null;

/** A JPEG no larger than [size] px on its long side, as base64; Windows only. */
export async function thumbnail(p, size = 160) {
  const reply = { type: "fs_thumb", path: p };
  let file;
  try { file = resolvePath(p); } catch (e) { return { ...reply, ok: false, error: e.message }; }
  if (!IS_WIN) return { ...reply, ok: false, error: "thumbnails need Windows" };
  if (!THUMB_EXT.test(file)) return { ...reply, ok: false, error: "not an image" };
  try { if (fs.statSync(file).size > 50 << 20) return { ...reply, ok: false, error: "too large" }; } catch (e) { return { ...reply, ok: false, error: e.message }; }
  thumbHelper ||= new PsHelper("thumbs", THUMB_SCRIPT);
  await thumbHelper.ensure();
  const r = await thumbHelper.cmd({ op: "thumb", path: file, size: Math.min(512, Math.max(32, Number(size) || 160)) }, 20000);
  return r.ok ? { ...reply, ok: true, jpeg: r.jpeg } : { ...reply, ok: false, error: r.error };
}

export function dispose() {
  thumbHelper?.kill();
}
