import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const parseRate = (s) =>
  /g/i.test(s)
    ? parseFloat(s) * 1e9
    : /m/i.test(s)
      ? parseFloat(s) * 1e6
      : /k/i.test(s)
        ? parseFloat(s) * 1e3
        : parseFloat(s);

export const clampQuality = (q) => Math.min(95, Math.max(10, Number(q) || 60));

/**
 * Resolve ffmpeg: FFMPEG_PATH (set at startup from the copy the installer bundles), then any
 * ffmpeg package this user installed with WinGet, then PATH. Nothing is tied to one user name or
 * one package id, so the same code works on another PC.
 */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const base = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    // <Packages>\<package id>\<version>\bin\ffmpeg.exe
    for (const pkg of fs.readdirSync(base, { withFileTypes: true })) {
      if (!pkg.isDirectory() || !/ffmpeg/i.test(pkg.name)) continue;
      const dir = path.join(base, pkg.name);
      for (const ver of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const p = path.join(dir, ver.name, "bin", "ffmpeg.exe");
        try {
          if (fs.existsSync(p)) return p;
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* no winget packages */
  }
  return "ffmpeg";
}

/** Capture a single frame via ffmpeg + DXGI Desktop Duplication (ddagrab).
 *  Captures exclusive fullscreen game surfaces that GDI CopyFromScreen cannot see.
 *  Returns { ok, b64, width, height } or { ok: false, error }.
 *
 *  ddagrab is a filter, not an input device: `-f ddagrab -i desktop` is rejected
 *  with "Unknown input format", so the frame never existed and this route always
 *  reported failure. The filter form below is the one the streaming path uses. */
/** The ffmpeg argv for one DXGI snapshot frame. Exported so the shape can be
 *  asserted without launching ffmpeg; the form is easy to get wrong and was. */
export function dxgiArgs(quality = 60, output = 0) {
  // MJPEG quality: -qscale:v 1..31, lower = better. Map our 0-100 quality to that range.
  const qscale = Math.round(31 - (Math.min(95, Math.max(10, quality)) / 100) * 30);
  // dup_frames=1: a still screen otherwise yields no frame at all and the pipe closes empty.
  const graph = `ddagrab=output_idx=${output}:framerate=1:dup_frames=1:draw_mouse=0,hwdownload,format=bgra`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-filter_complex",
    graph,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-qscale:v",
    String(qscale),
    "-",
  ];
}

export async function captureFrameDXGI(quality = 60, output = 0) {
  const ffmpeg = ffmpegPath();

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let resolved = false;
    const child = spawn(ffmpeg, dxgiArgs(quality, output), { windowsHide: true });

    const finish = (ok, error, b64, width, height) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok, error, b64, width, height });
    };

    const timer = setTimeout(() => finish(false, "ffmpeg_timeout"), 10000);

    child.stdout.on("data", (d) => {
      stdout = Buffer.concat([stdout, d]);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (resolved) return;
      if (code === 0 && stdout.length > 0) {
        try {
          const b64 = stdout.toString("base64");
          // Parse JPEG SOF0 marker for dimensions: FF C0 .. length .. precision H W
          let w = 0,
            h = 0;
          for (let i = 2; i < stdout.length - 5; i++) {
            if (stdout[i] === 0xff && stdout[i + 1] === 0xc0) {
              h = stdout.readUInt16BE(i + 5);
              w = stdout.readUInt16BE(i + 7);
              break;
            }
          }
          finish(true, null, b64, w || 0, h || 0);
        } catch {
          finish(true, null, stdout.toString("base64"), 0, 0);
        }
      } else {
        finish(false, stderr.trim() || `ffmpeg exited ${code}`);
      }
    });

    child.on("error", (e) => {
      finish(false, e.message);
    });
  });
}
