/**
 * clippy bridge — PocketDesk side of the clippy keystroke recorder.
 *
 * clippy.exe (built from ../clippy/clippy.cs) runs as an elevated scheduled task
 * with a low-level keyboard hook. On Ctrl+C it writes clippy_capture.json
 * (overwritten each time — no file pileup) holding the foreground window title
 * plus the system clipboard text at that instant, and appends to
 * clippy_history.json (last 20 entries).
 *
 * Everything happens in the daemon. The browser toggle sends clippy_start /
 * clippy_stop; the daemon installs clippy as a HighestAvailable scheduled task
 * (one UAC prompt) so its hook sees elevated windows too, then starts/stops it
 * through the task. Captured Ctrl+C text is pushed to connected clients as a
 * clippy_copy event, and clippy_paste_last sets the system clipboard +
 * simulates Ctrl+V so Ctrl+V outside the game pastes what was copied inside.
 *
 * Windows only. clippy.exe must live next to this module (daemon/clippy/clippy.exe).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const CLIPPY_EXE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "clippy", "clippy.exe");
const CLIPPY_DIR = path.dirname(CLIPPY_EXE);
const TASK = "Clippy";
const DIR_CONFIG_FILE = path.join(CLIPPY_DIR, "clippy_dir.txt");
const CAPTURE_NAME = "clippy_capture.json";
const HISTORY_NAME = "clippy_history.json";

/**
 * Where clippy stores its data: the path in clippy_dir.txt beside the exe when it is
 * set and usable, otherwise the exe's own folder. clippy.exe reads the same file.
 */
function dataDir() {
  try {
    const p = fs.readFileSync(DIR_CONFIG_FILE, "utf8").trim();
    if (p && path.isAbsolute(p)) {
      try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch { /* created by clippy */ }
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no override set */ }
  return CLIPPY_DIR;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** History is newline-delimited JSON (one capture per line). */
function readHistory(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n").map((s) => s.trim()).filter(Boolean)
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean).slice(-20);
  } catch { return []; }
}

export class Clippy {
  constructor() {
    this.running = false;
    this.installed = false;
    this.onCopy = null;   // ( { window, text, at } ) => void
    this.onState = null;  // ( { running, installed } ) => void
    this._timer = null;
    this._lastCapture = null; // mtime of clippy_capture.json
  }

  /** Tell every listener (server broadcasts it as clippy_state) about state changes. */
  _emit() {
    if (this.onState) try { this.onState({ running: this.running, installed: this.installed, dir: dataDir() }); } catch { /* silent */ }
  }

  /** The directory clippy writes its capture/history files to. */
  getDir() { return dataDir(); }

  /**
   * Point clippy at a new data directory (persisted in clippy_dir.txt beside the exe).
   * Empty string resets to the exe's own folder. The path must be absolute and writable.
   */
  async setDir(dir) {
    const raw = String(dir ?? "").trim();
    if (raw && !path.isAbsolute(raw)) return { ok: false, error: "path must be absolute (e.g. D:\\clippy-data)" };
    if (raw) {
      try {
        fs.mkdirSync(raw, { recursive: true });
        const probe = path.join(raw, ".clippy_write_test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
      } catch (e) { return { ok: false, error: `cannot write to ${raw}: ${e.message}` }; }
    }
    try {
      if (raw) fs.writeFileSync(DIR_CONFIG_FILE, raw + "\n");
      else { try { fs.unlinkSync(DIR_CONFIG_FILE); } catch { /* already absent */ } }
    } catch (e) { return { ok: false, error: e.message }; }
    this._lastCapture = null; // re-read the capture from the new location
    this._emit();
    return { ok: true, dir: dataDir() };
  }

  /** Is the Clippy scheduled task registered? */
  _taskExists() {
    try {
      const out = execFileSync("schtasks.exe", ["/Query", "/TN", TASK], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      return out.includes(TASK);
    } catch { return false; }
  }

  /** Install clippy as a HighestAvailable scheduled task (elevated: UAC prompt once). */
  async install() {
    if (this._taskExists()) { this.installed = true; this._emit(); return { ok: true, already: true }; }
    if (!fs.existsSync(CLIPPY_EXE)) return { ok: false, error: `clippy.exe not found at ${CLIPPY_EXE}` };
    try {
      execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", `Start-Process -FilePath '${CLIPPY_EXE}' -ArgumentList '--install' -Verb runas -Wait`
      ], { encoding: "utf8", windowsHide: true });
    } catch (e) { return { ok: false, error: e.message }; }
    this.installed = true;
    this._emit();
    return { ok: true };
  }

  /** Start clippy through its elevated scheduled task. Installs first if needed. */
  async start() {
    if (this.running) return { ok: true, already: true };
    if (!fs.existsSync(CLIPPY_EXE)) return { ok: false, error: `clippy.exe not found at ${CLIPPY_EXE}` };
    if (!this.installed && !this._taskExists()) {
      const inst = await this.install();
      if (!inst.ok) return inst;
    }
    try {
      execFileSync("schtasks.exe", ["/Run", "/TN", TASK], { encoding: "utf8", windowsHide: true });
      this.running = true;
      this._startWatch();
      this._emit();
      return { ok: true };
    } catch (e) {
      this.running = false;
      return { ok: false, error: e.message };
    }
  }

  /** Stop clippy and the watcher. */
  async stop() {
    this._stopWatch();
    try { execFileSync("schtasks.exe", ["/End", "/TN", TASK], { encoding: "utf8", windowsHide: true }); } catch { /* already gone */ }
    this.running = false;
    this._emit();
    return { ok: true };
  }

  _startWatch() {
    this._stopWatch();
    this._checkCapture(); // immediate first pass
    this._timer = setInterval(() => this._checkCapture(), 500);
  }

  _stopWatch() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _checkCapture() {
    try {
      const capFile = path.join(dataDir(), CAPTURE_NAME);
      if (!fs.existsSync(capFile)) return;
      const st = fs.statSync(capFile);
      if (this._lastCapture && st.mtimeMs <= this._lastCapture) return;
      this._lastCapture = st.mtimeMs;
      const cap = readJson(capFile);
      if (cap && (cap.text || cap.typed) && this.onCopy) {
        try { this.onCopy({ window: cap.window || "", text: cap.text || "", typed: cap.typed || "", at: cap.at || "" }); } catch { /* callback must not kill the watcher */ }
      }
    } catch { /* directory may not exist yet; silent */ }
  }

  /** Current state: running flag, installed flag, data dir, recent history, exe path. */
  async status() {
    this.installed = this._taskExists();
    const dir = dataDir();
    const history = readHistory(path.join(dir, HISTORY_NAME));
    this._emit();
    return { ok: true, running: this.running, installed: this.installed, exe: CLIPPY_EXE, dir, history };
  }

  /** The most recent Ctrl+C capture, or { ok:false } when none yet. */
  async latest() {
    const cap = readJson(path.join(dataDir(), CAPTURE_NAME));
    if (!cap || (!cap.text && !cap.typed)) return { ok: false, error: "no clippy capture yet" };
    return { ok: true, window: cap.window || "", text: cap.text || "", typed: cap.typed || "", at: cap.at || "" };
  }
}
