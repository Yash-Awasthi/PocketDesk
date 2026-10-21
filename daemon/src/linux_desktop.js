/**
 * Linux X11 desktop backend: screen capture via ffmpeg x11grab (wired in desktop_video.js), input
 * via xdotool, monitor geometry via xrandr. Wayland sessions have no X server
 * to grab, so this reports unsupported there; X11 (or XWayland with an X grab) works.
 *
 * The pure helpers here (argument building, xrandr parsing, key mapping) are unit-tested; the spawns
 * that touch a real display cannot run in CI, so they stay thin and degrade when a tool is missing.
 */
import { spawn, execFile, execFileSync } from "node:child_process";

export const IS_LINUX = process.platform === "linux";
const X11 = IS_LINUX && process.env.XDG_SESSION_TYPE !== "wayland" && !!process.env.DISPLAY;

/** Whether a command is on PATH (used to pick xdotool/xrandr/xclip or degrade cleanly). */
export function hasTool(name, run = (c) => { execFileSync(c, ["--version"], { stdio: "ignore" }); }) {
  try { run(name); return true; } catch { return false; }
}

/** Monitors from `xrandr --listmonitors` output, in its order, with geometry in X pixels. */
export function parseXrandrMonitors(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    // e.g. " 0: +*HDMI-1 1920/510x1080/290+0+0  HDMI-1"
    const m = line.match(/^\s*(\d+):\s+\+?(\*)?\S*?([\w.-]+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
    if (!m) continue;
    out.push({ index: Number(m[1]), name: m[3], w: Number(m[4]), h: Number(m[5]), x: Number(m[6]), y: Number(m[7]), primary: !!m[2] });
  }
  return out;
}

// Windows virtual-key codes (what the phone and web client send) to xdotool key names.
const XDO_KEYS = {
  0x08: "BackSpace", 0x09: "Tab", 0x0d: "Return", 0x13: "Pause", 0x14: "Caps_Lock", 0x1b: "Escape", 0x20: "space",
  0x21: "Prior", 0x22: "Next", 0x23: "End", 0x24: "Home", 0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down",
  0x2c: "Print", 0x2d: "Insert", 0x2e: "Delete", 0x5b: "Super_L", 0x5c: "Super_R", 0x5d: "Menu",
  0x6a: "KP_Multiply", 0x6b: "KP_Add", 0x6d: "KP_Subtract", 0x6e: "KP_Decimal", 0x6f: "KP_Divide",
  0x90: "Num_Lock", 0x91: "Scroll_Lock", 0xba: "semicolon", 0xbb: "equal", 0xbc: "comma", 0xbd: "minus",
  0xbe: "period", 0xbf: "slash", 0xc0: "grave", 0xdb: "bracketleft", 0xdc: "backslash", 0xdd: "bracketright", 0xde: "apostrophe",
  0xa0: "Shift_L", 0xa1: "Shift_R", 0xa2: "Control_L", 0xa3: "Control_R", 0xa4: "Alt_L", 0xa5: "Alt_R",
  0xad: "XF86AudioMute", 0xae: "XF86AudioLowerVolume", 0xaf: "XF86AudioRaiseVolume",
  0xb0: "XF86AudioNext", 0xb1: "XF86AudioPrev", 0xb3: "XF86AudioPlay",
};
const MODS = { ctrl: "ctrl", alt: "alt", shift: "shift", win: "super" };

/** The xdotool key name for a Windows virtual key, or null when there is none. */
export function xdoKey(vk) {
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk + 32); // A-Z -> a-z (xdotool keysym)
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk); // 0-9
  if (vk >= 0x60 && vk <= 0x69) return "KP_" + (vk - 0x60); // numpad 0-9
  if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6f); // F1-F24
  return XDO_KEYS[vk] || null;
}

/** A full `key` combo as the chord xdotool wants, e.g. ctrl+alt+Delete, or null for an unknown key. */
export function xdoChord(vk, modifiers = []) {
  const key = xdoKey(vk);
  if (!key) return null;
  const mods = modifiers.map((m) => MODS[m]).filter(Boolean);
  return [...mods, key].join("+");
}

export class LinuxDesktop {
  constructor() {
    this.xdotool = X11 && hasTool("xdotool");
    this.xrandr = X11 && hasTool("xrandr");
  }

  get supported() { return !!this.xdotool; }

  async monitors() {
    if (!this.xrandr) return [];
    const text = await this._run("xrandr", ["--listmonitors"]).catch(() => "");
    return parseXrandrMonitors(text);
  }

  /** x/y are X-screen pixels; buttons 1 left, 2 middle, 3 right; wheel 4 up/5 down, 6/7 horizontal. */
  async mouse({ x, y, click, press, button, wheel, hwheel }) {
    if (!this.xdotool) return { ok: false, error: "no_xdotool" };
    const btn = button === "right" ? 3 : button === "middle" ? 2 : 1;
    const args = [];
    if (x != null && y != null) args.push("mousemove", String(Math.round(x)), String(Math.round(y)));
    if (click) {
      const cb = click === "right" ? 3 : click === "middle" ? 2 : 1;
      args.push("click", String(cb));
      if (click === "double") args.push("click", "1");
    }
    if (press === "down") args.push("mousedown", String(btn));
    if (press === "up") args.push("mouseup", String(btn));
    for (let n = Math.round(Math.abs(Number(wheel) || 0) / 120); n > 0; n--) args.push("click", wheel > 0 ? "4" : "5");
    for (let n = Math.round(Math.abs(Number(hwheel) || 0) / 120); n > 0; n--) args.push("click", hwheel > 0 ? "7" : "6");
    if (!args.length) return { ok: true };
    return this._xdo(args);
  }

  async key({ key, modifiers = [], press }) {
    if (!this.xdotool) return { ok: false, error: "no_xdotool" };
    const name = xdoKey(Number(key));
    if (!name) return { ok: false, error: "unmapped_key" };
    if (press === "down") return this._xdo(["keydown", name]);
    if (press === "up") return this._xdo(["keyup", name]);
    const chord = xdoChord(Number(key), modifiers);
    return this._xdo(["key", chord]);
  }

  async type(text) {
    if (!this.xdotool) return { ok: false, error: "no_xdotool" };
    return this._xdo(["type", "--clearmodifiers", String(text).slice(0, 512)]);
  }

  /** The pointer's X-screen position, or null; shape/visible are unknown to xdotool so stay fixed. */
  async pointer() {
    if (!this.xdotool) return null;
    const out = await this._run("xdotool", ["getmouselocation", "--shell"]).catch(() => "");
    const x = /X=(\d+)/.exec(out), y = /Y=(\d+)/.exec(out);
    return x && y ? { x: Number(x[1]), y: Number(y[1]), shape: "arrow", visible: true } : null;
  }

  async _xdo(args) {
    try { await this._run("xdotool", args); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  _run(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
  }
}
