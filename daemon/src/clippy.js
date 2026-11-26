/**
 * clippy bridge — PocketDesk side of the clippy keystroke recorder.
 *
 * clippy.exe (built from ../clippy/clippy.cs) runs as an elevated scheduled task
 * with a low-level keyboard hook. On Ctrl+C it overwrites clippy_capture.json with the
 * latest snapshot (foreground window title, system clipboard text and the typed buffer
 * since the previous Ctrl+C) and rewrites clippy_history.json with the last 20 captures.
 * The UI shows that same tail.
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

const CLIPPY_EXE = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "clippy",
  "clippy.exe",
);
const CLIPPY_DIR = path.dirname(CLIPPY_EXE);
const TASK = "Clippy";
const DIR_CONFIG_FILE = path.join(CLIPPY_DIR, "clippy_dir.txt");
const CAPTURE_NAME = "clippy_capture.json";
const HISTORY_NAME = "clippy_history.json";
// An install under Program Files cannot write beside the exe; both sides fall back here.
const FALLBACK_DIR = path.join(process.env.LOCALAPPDATA || path.dirname(CLIPPY_DIR), "PocketDesk", "clippy");

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".clippy_write_test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let cachedDir = null;

/**
 * Where clippy stores its data: the path in clippy_dir.txt beside the exe when it is set and usable,
 * otherwise one folder per user, then the exe's own folder, then that per-user folder whatever
 * happens. clippy.cs applies the same rules, so a checkout and an installed copy share one place
 * and nothing is written into a program folder or a git worktree by default.
 */
function dataDir() {
  if (cachedDir) return cachedDir;
  try {
    const p = fs.readFileSync(DIR_CONFIG_FILE, "utf8").trim();
    if (p && path.isAbsolute(p) && writable(p)) return (cachedDir = p);
  } catch {
    /* no override set */
  }
  try {
    fs.mkdirSync(FALLBACK_DIR, { recursive: true });
  } catch {
    /* reported on write */
  }
  if (writable(FALLBACK_DIR)) return (cachedDir = FALLBACK_DIR);
  if (writable(CLIPPY_DIR)) return (cachedDir = CLIPPY_DIR);
  return (cachedDir = FALLBACK_DIR);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * History is newline-delimited JSON (one capture per line) and append-only, so only its tail is
 * read: a long session log must not be loaded whole on every status request.
 */
function readHistory(file, limit = 20) {
  try {
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // A read that starts mid-line leaves an incomplete first entry; parsing drops it.
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

export class Clippy {
  constructor() {
    this.running = false;
    this.installed = false;
    this.onCopy = null; // ( { window, text, at } ) => void
    this.onState = null; // ( { running, installed } ) => void
    this._timer = null;
    this._lastCapture = null; // "mtime:size" of the last clippy_capture.json seen
    this._startedAt = 0; // a task takes a moment to spawn its process; do not un-set running yet
  }

  /** Tell every listener (server broadcasts it as clippy_state) about state changes. */
  _emit() {
    if (this.onState)
      try {
        this.onState({ running: this.running, installed: this.installed, dir: dataDir() });
      } catch {
        /* silent */
      }
  }

  /** The directory clippy writes its capture/history files to. */
  getDir() {
    return dataDir();
  }

  /**
   * Point clippy at a new data directory (persisted in clippy_dir.txt beside the exe).
   * Empty string resets to the exe's own folder. The path must be absolute and writable.
   */
  async setDir(dir) {
    const raw = String(dir ?? "").trim();
    if (raw && !path.isAbsolute(raw))
      return { ok: false, error: "path must be absolute (e.g. D:\\clippy-data)" };
    if (raw && !writable(raw)) return { ok: false, error: `cannot write to ${raw}` };
    try {
      if (raw) fs.writeFileSync(DIR_CONFIG_FILE, raw + "\n");
      else {
        try {
          fs.unlinkSync(DIR_CONFIG_FILE);
        } catch {
          /* already absent */
        }
      }
    } catch (e) {
      // A read-only install cannot persist the choice; the task still starts with --dir.
      if (!raw) return { ok: false, error: e.message };
    }
    cachedDir = raw || null;
    this._lastCapture = null; // re-read the capture from the new location
    this._emit();
    return { ok: true, dir: dataDir() };
  }

  /** Is the Clippy scheduled task registered? */
  _taskXml() {
    try {
      return execFileSync("schtasks.exe", ["/Query", "/TN", TASK, "/XML"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }

  _taskExists() {
    return this._taskXml().includes("<Task ");
  }

  /**
   * Is clippy.exe actually running? The in-memory flag only knows about this daemon run, while the
   * task outlives it, so the process table is the source of truth (tasklist output is not localized).
   */
  _processRunning() {
    try {
      const out = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq clippy.exe", "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return /"clippy\.exe"/i.test(out);
    } catch {
      return null;
    }
  }

  /** Install clippy as a HighestAvailable scheduled task (elevated: UAC prompt once). */
  async install() {
    const dir = dataDir();
    const xml = this._taskXml();
    if (
      xml.includes("<Task ") &&
      xml.includes(dir.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    ) {
      this.installed = true;
      this._emit();
      return { ok: true, already: true };
    }
    if (!fs.existsSync(CLIPPY_EXE)) return { ok: false, error: `clippy.exe not found at ${CLIPPY_EXE}` };
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Start-Process -FilePath '${CLIPPY_EXE.replace(/'/g, "''")}' -ArgumentList '--install','--dir','${dir.replace(/'/g, "''")}' -Verb runas -Wait`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
    } catch (e) {
      return { ok: false, error: e.message };
    }
    this.installed = true;
    this._emit();
    return { ok: true };
  }

  /** Start clippy through its elevated scheduled task. Installs (or refreshes) it first if needed. */
  async start() {
    if (this.running) return { ok: true, already: true };
    if (!fs.existsSync(CLIPPY_EXE)) return { ok: false, error: `clippy.exe not found at ${CLIPPY_EXE}` };
    // A task started before this daemon run is already recording; /Run would fail on it.
    if (this._processRunning()) {
      this.running = true;
      this._lastCapture = null;
      this._startWatch();
      this._emit();
      return { ok: true, already: true };
    }
    const inst = await this.install();
    if (!inst.ok) return inst;
    try {
      execFileSync("schtasks.exe", ["/Run", "/TN", TASK], { encoding: "utf8", windowsHide: true });
      this.running = true;
      this._startedAt = Date.now();
      this._lastCapture = null; // a run starts a fresh capture file
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
    try {
      execFileSync("schtasks.exe", ["/End", "/TN", TASK], { encoding: "utf8", windowsHide: true });
    } catch {
      /* already gone */
    }
    this._startedAt = 0;
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
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _checkCapture() {
    try {
      const capFile = path.join(dataDir(), CAPTURE_NAME);
      if (!fs.existsSync(capFile)) return;
      const st = fs.statSync(capFile);
      // Size as well as mtime: two captures inside one filesystem timestamp tick still differ.
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp === this._lastCapture) return;
      this._lastCapture = stamp;
      const cap = readJson(capFile);
      if (cap && (cap.text || cap.typed) && this.onCopy) {
        try {
          this.onCopy({
            window: cap.window || "",
            text: cap.text || "",
            typed: cap.typed || "",
            at: cap.at || "",
          });
        } catch {
          /* callback must not kill the watcher */
        }
      }
    } catch {
      /* directory may not exist yet; silent */
    }
  }

  /** Current state: running flag, installed flag, data dir, recent history, exe path. */
  async status() {
    this.installed = this._taskExists();
    const live = this._processRunning();
    // Just-started clippy.exe may not be in the process table yet; let the flag stand for a moment.
    if (live !== null && Date.now() - this._startedAt > 5000 && live !== this.running) {
      this.running = live;
      if (live) this._startWatch();
      else this._stopWatch();
    }
    const dir = dataDir();
    const history = readHistory(path.join(dir, HISTORY_NAME));
    this._emit();
    return { ok: true, running: this.running, installed: this.installed, exe: CLIPPY_EXE, dir, history };
  }

  /** The most recent Ctrl+C capture, or the history entry with [at] when given. */
  async latest(at) {
    if (at) {
      const hit = readHistory(path.join(dataDir(), HISTORY_NAME), 200)
        .reverse()
        .find((e) => e.at === at);
      if (hit)
        return {
          ok: true,
          window: hit.window || "",
          text: hit.text || "",
          typed: hit.typed || "",
          at: hit.at || "",
        };
    }
    const cap = readJson(path.join(dataDir(), CAPTURE_NAME));
    if (!cap || (!cap.text && !cap.typed)) return { ok: false, error: "no clippy capture yet" };
    return {
      ok: true,
      window: cap.window || "",
      text: cap.text || "",
      typed: cap.typed || "",
      at: cap.at || "",
    };
  }

  /**
   * Daemon shutdown: stop watching, but leave the recorder alone. It is an on-demand scheduled task
   * at the interactive session, so "running" survives a daemon restart instead of silently turning
   * off every time PocketDesk restarts; stopping it is the Stop switch (or clippy --stop).
   */
  dispose() {
    this._stopWatch();
    this.running = false;
  }
}
