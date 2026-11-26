/**
 * Audit trail of remote access, kept on the PC in ~/.pocketdesk/recordings.
 * sessions.log (always): one JSON line per viewer joining or leaving and per approval.
 * With the record-sessions flag, toggled from the tray: the screen as MP4 while anyone
 * watches, and every terminal session as an asciicast v2 file (output only, never input).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "./config.js";

export const RECORD_FLAG = path.join(configDir, "record-sessions");
export const RECORDINGS = path.join(configDir, "recordings");

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const safe = (s) =>
  String(s || "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 40);

/* eslint-disable no-control-regex -- the point is stripping control characters */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /\x1b\[[0-?]*[ !-/]*[@-~]/g;
const ESC = /\x1b[\s\S]?/g;
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

const stripAnsi = (s) => s.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(C0, "");

/** Read an asciicast v2 file back as plain text: output only, no escapes, last overwrite per line. */
export function replayCast(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (!lines.length) throw new Error("not an asciicast v2 recording");
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("not an asciicast v2 recording");
  }
  if (!header || typeof header !== "object" || header.version !== 2)
    throw new Error("not an asciicast v2 recording");
  let output = "";
  for (const line of lines.slice(1)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a recording cut off mid-line is still worth replaying up to the cut.
    }
    if (Array.isArray(event) && event[1] === "o" && typeof event[2] === "string") output += event[2];
  }
  const plain = stripAnsi(output).replace(/\r\n/g, "\n");
  const kept = [];
  for (const raw of plain.split("\n")) {
    const line = raw.split("\r").pop().trimEnd();
    if (!line || kept[kept.length - 1] === line) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/** Cap for retained recordings; RH_RECORD_KEEP overrides the default of 50. */
export function defaultKeep() {
  const n = Number(process.env.RH_RECORD_KEEP);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

/** Delete the oldest .cast/.mp4 files beyond [keep]; sessions.log and other files stay. */
export function pruneRecordings(dir, keep = defaultKeep()) {
  const cap = Number.isInteger(keep) && keep >= 0 ? keep : defaultKeep();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const media = [];
  for (const name of names) {
    if (!name.endsWith(".cast") && !name.endsWith(".mp4")) continue;
    try {
      media.push({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs });
    } catch {}
  }
  if (media.length <= cap) return [];
  media.sort((a, b) => b.mtime - a.mtime);
  const deleted = [];
  for (const { name } of media.slice(cap)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      deleted.push(name);
    } catch {}
  }
  return deleted;
}

/** ffmpeg arguments for the audit copy of the screen: 10 fps, pointer drawn, playable even if cut off. */
export function screenArgs(file, monitor) {
  const adapter = monitor?.adapter || 0;
  // The audit copy has to show what the viewer saw: the whole extended desktop when that is the chosen
  // view (ddagrab can only take one output, so the desktop comes from GDI), one output otherwise.
  const input = monitor?.all
    ? [
        "-f",
        "gdigrab",
        "-draw_mouse",
        "1",
        "-framerate",
        "10",
        "-i",
        "desktop",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      ]
    : [
        ...(adapter ? ["-init_hw_device", `d3d11va=rec:${adapter}`, "-filter_hw_device", "rec"] : []),
        "-filter_complex",
        `ddagrab=output_idx=${monitor?.output || 0}:framerate=10,hwdownload,format=bgra,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
      ];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...input,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-g",
    "100",
    // Fragmented MP4 stays playable up to the last fragment if the daemon dies mid-recording.
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "-y",
    file,
  ];
}

export class Recorder {
  constructor({
    ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
    recordings = RECORDINGS,
    flag = RECORD_FLAG,
  } = {}) {
    this.ffmpeg = ffmpeg;
    this.recordings = recordings;
    this.flag = flag;
    this.screen = null;
    this.casts = new Map();
  }

  get enabled() {
    return fs.existsSync(this.flag);
  }

  log(event, fields = {}) {
    try {
      fs.mkdirSync(this.recordings, { recursive: true });
      fs.appendFileSync(
        path.join(this.recordings, "sessions.log"),
        JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n",
      );
    } catch {
      /* the audit log never takes the session down */
    }
  }

  /** Follows whether anyone is watching; starts only when the flag is on. */
  screenWatched(watching, { label, monitor } = {}) {
    if (watching && !this.screen && this.enabled) this._startScreen(label, monitor);
    else if (!watching && this.screen) this._stopScreen();
  }

  get recordingScreen() {
    return !!this.screen;
  }

  _startScreen(label, monitor) {
    fs.mkdirSync(this.recordings, { recursive: true });
    pruneRecordings(this.recordings);
    const file = path.join(this.recordings, `desktop-${stamp()}-${safe(label)}.mp4`);
    let proc;
    try {
      proc = spawn(this.ffmpeg, screenArgs(file, monitor), {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return this.log("recording_failed", { error: e.message });
    }
    let err = "";
    proc.stderr.on("data", (d) => {
      err = (err + d).slice(-500);
    });
    proc.on("error", (e) => {
      this.log("recording_failed", { error: e.message });
      if (this.screen?.proc === proc) this.screen = null;
    });
    proc.on("exit", (code) => {
      if (this.screen?.proc === proc) this.screen = null;
      this.log("recording_saved", { file, code, error: code ? err.trim() : undefined });
    });
    this.screen = { proc, file };
    this.log("recording_started", { file });
  }

  _stopScreen() {
    const { proc } = this.screen;
    this.screen = null;
    // "q" lets ffmpeg write its last fragment; a stuck one is killed.
    try {
      proc.stdin.end("q");
    } catch {}
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 5000).unref();
  }

  terminalStarted({ id, harnessId, cwd }) {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.recordings, { recursive: true });
      pruneRecordings(this.recordings);
      const file = path.join(this.recordings, `terminal-${stamp()}-${safe(harnessId)}-${id}.cast`);
      const out = fs.createWriteStream(file);
      out.write(
        JSON.stringify({
          version: 2,
          width: 100,
          height: 30,
          timestamp: Math.floor(Date.now() / 1000),
          title: `${harnessId} in ${cwd}`,
        }) + "\n",
      );
      this.casts.set(id, { out, t0: Date.now() });
    } catch {
      /* recording is best effort */
    }
  }

  terminalOutput(id, text) {
    const c = this.casts.get(id);
    if (c) c.out.write(JSON.stringify([(Date.now() - c.t0) / 1000, "o", text]) + "\n");
  }

  terminalResized(id, cols, rows) {
    const c = this.casts.get(id);
    if (c) c.out.write(JSON.stringify([(Date.now() - c.t0) / 1000, "r", `${cols}x${rows}`]) + "\n");
  }

  terminalEnded(id) {
    this.casts.get(id)?.out.end();
    this.casts.delete(id);
  }

  dispose() {
    if (this.screen) this._stopScreen();
    for (const id of [...this.casts.keys()]) this.terminalEnded(id);
  }
}
