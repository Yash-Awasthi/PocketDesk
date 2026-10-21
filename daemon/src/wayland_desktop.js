/**
 * Linux Wayland desktop backend for wlroots compositors (Sway, Hyprland, river...): video from wf-recorder,
 * the pointer moved through the compositor (swaymsg, hyprctl; ydotool elsewhere), buttons through swaymsg
 * or ydotool (its ydotoold must run), keys and text through wtype, monitors from wlr-randr. GNOME and KDE allow screen capture only through the portal and report unsupported here.
 * The argument builders are unit-tested; the tools themselves need a live session.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { xdoKey } from "./linux_desktop.js";
import { ENCODERS } from "./desktop_video.js";

/** The Wayland socket: from the session, or found in the runtime dir when a user service started without it. */
export function waylandDisplay(env = process.env, list = (dir) => fs.readdirSync(dir)) {
  if (env.WAYLAND_DISPLAY) return env.WAYLAND_DISPLAY;
  const dir = env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : "");
  try { return list(dir).find((n) => /^wayland-\d+$/.test(n)) || null; } catch { return null; }
}

export const IS_WAYLAND = process.platform === "linux" && !!waylandDisplay()
  && (process.env.XDG_SESSION_TYPE === "wayland" || !process.env.DISPLAY);

/** Enabled outputs from `wlr-randr --json`, sized in layout pixels (the current mode over the scale). */
export function parseWlrRandr(text) {
  let outs;
  try { outs = JSON.parse(text); } catch { return []; }
  return (Array.isArray(outs) ? outs : []).filter((o) => o.enabled).map((o, index) => {
    const mode = (o.modes || []).find((m) => m.current) || { width: 0, height: 0 };
    const scale = Number(o.scale) || 1;
    return { index, name: o.name, w: Math.round(mode.width / scale), h: Math.round(mode.height / scale), x: o.position?.x || 0, y: o.position?.y || 0, primary: index === 0 };
  });
}

const onPath = (name) => (process.env.PATH || "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));

/** ydotool emulates absolute moves with relative ones, which acceleration skews, so compositors that can place the pointer do. */
export function moveArgs(compositor, x, y) {
  const [X, Y] = [String(Math.round(x)), String(Math.round(y))];
  if (compositor === "sway") return ["swaymsg", ["seat", "-", "cursor", "set", X, Y]];
  if (compositor === "hyprland") return ["hyprctl", ["dispatch", "movecursor", X, Y]];
  return ["ydotool", ["mousemove", "--absolute", "-x", X, "-y", Y]];
}

const SWAY_BUTTON = { left: "button1", middle: "button2", right: "button3" };
const YDO_BUTTON = { left: 0, right: 1, middle: 2 };

/** The commands for a click, a held button or wheel steps (120 per notch), as [bin, args] pairs. */
export function buttonArgs(compositor, { click, press, button = "left", wheel, hwheel }) {
  const out = [];
  const sway = (action, b) => out.push(["swaymsg", ["seat", "-", "cursor", action, b]]);
  const ydo = (code) => out.push(["ydotool", ["click", "0x" + code.toString(16).toUpperCase()]]);
  if (click) {
    const b = click === "double" ? "left" : click;
    for (let n = click === "double" ? 2 : 1; n > 0; n--) {
      if (compositor === "sway") { sway("press", SWAY_BUTTON[b]); sway("release", SWAY_BUTTON[b]); } else ydo(0xc0 | YDO_BUTTON[b]);
    }
  }
  if (press) {
    if (compositor === "sway") sway(press === "down" ? "press" : "release", SWAY_BUTTON[button]);
    else ydo((press === "down" ? 0x40 : 0x80) | YDO_BUTTON[button]);
  }
  const steps = (v) => Math.round((Number(v) || 0) / 120);
  const [v, h] = [steps(wheel), steps(hwheel)];
  if (compositor === "sway") {
    // Buttons 4-7 are the axes: up, down, left, right.
    for (let n = Math.abs(v); n > 0; n--) { sway("press", v > 0 ? "button4" : "button5"); sway("release", v > 0 ? "button4" : "button5"); }
    for (let n = Math.abs(h); n > 0; n--) { sway("press", h > 0 ? "button7" : "button6"); sway("release", h > 0 ? "button7" : "button6"); }
  } else if (v || h) out.push(["ydotool", ["mousemove", "--wheel", "-x", String(h), "-y", String(v)]]);
  return out;
}

/** wtype arguments for a key (Windows virtual key, as the phone sends) or for text; null for an unmapped key. */
export function wtypeArgs({ key, modifiers = [], press, text }) {
  if (text != null) return ["--", String(text).slice(0, 512)];
  const name = xdoKey(Number(key));
  if (!name) return null;
  if (press) return [press === "down" ? "-P" : "-p", name];
  const mods = modifiers.map((m) => ({ ctrl: "ctrl", alt: "alt", shift: "shift", win: "logo" })[m]).filter(Boolean);
  return [...mods.flatMap((m) => ["-M", m]), "-k", name, ...mods.flatMap((m) => ["-m", m])];
}

/** wf-recorder for one output, writing FLV to stdout like the ffmpeg grab, with the encoder's own options. */
export function wfRecorderArgs(enc, p, monitor) {
  const opts = [];
  const list = ENCODERS[enc](p.q, p);
  for (let i = 0; i < list.length; i += 2) opts.push("-p", `${list[i].replace(/^-/, "")}=${list[i + 1]}`);
  return [
    ...(monitor?.name ? ["-o", monitor.name] : []), "-c", enc, ...(enc.endsWith("_vaapi") ? ["-d", "/dev/dri/renderD128"] : []),
    ...opts, "-r", String(p.fps), ...(p.scale === 1 ? [] : ["-F", `scale=trunc(iw*${p.scale}/2)*2:-2`]),
    ...(enc.endsWith("_vaapi") ? [] : ["-x", "yuv420p"]), "-p", `g=${p.fps}`, "-p", "bf=0", "-m", "flv", "-f", "/dev/stdout", "-y",
  ];
}

export class WaylandDesktop {
  constructor() {
    this.env = { ...process.env, WAYLAND_DISPLAY: waylandDisplay() || "" };
    this.compositor = this._ok("swaymsg", ["-t", "get_version"]) ? "sway" : this._ok("hyprctl", ["version"]) ? "hyprland" : null;
    this.wtype = onPath("wtype");
    this.ydotool = onPath("ydotool");
    this.randr = onPath("wlr-randr");
  }

  get supported() { return onPath("wf-recorder") && (this.compositor === "sway" || this.ydotool); }

  async monitors() {
    if (!this.randr) return [];
    return parseWlrRandr(await this._run("wlr-randr", ["--json"]).catch(() => "[]"));
  }

  /** x/y are layout pixels, the space the monitors are listed in. */
  async mouse({ x, y, ...buttons }) {
    try {
      if (x != null && y != null) await this._run(...moveArgs(this.compositor, x, y));
      for (const [bin, args] of buttonArgs(this.compositor, buttons)) await this._run(bin, args);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async key(k) { return this._wtype(wtypeArgs(k)); }

  async type(text) { return this._wtype(wtypeArgs({ text })); }

  // Wayland lets no client read the pointer position.
  async pointer() { return null; }

  async _wtype(args) {
    if (!this.wtype) return { ok: false, error: "no_wtype" };
    if (!args) return { ok: false, error: "unmapped_key" };
    try { await this._run("wtype", args); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }

  _ok(cmd, args) {
    try { execFileSync(cmd, args, { stdio: "ignore", env: this.env, timeout: 3000 }); return true; } catch { return false; }
  }

  _run(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 5000, env: this.env }, (err, out) => (err ? reject(err) : resolve(out)));
    });
  }
}
