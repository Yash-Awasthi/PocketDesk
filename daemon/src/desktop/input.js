import { EventEmitter } from "node:events";
import { jpegRect } from "./topology.js";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// UIPI: Windows drops input from a normal process into an elevated window, with no other signal.
const ELEVATED =
  "An administrator window (such as Task Manager) has focus, and Windows blocks remote input to it. " +
  "Click another window, or install console access on the PC to control admin windows.";
// macOS drops synthetic input, and returns no screen pixels, until the user allows each one.
const MAC_HELP = {
  accessibility_permission:
    "The Mac blocks remote input until you allow PocketDesk (it may be listed as node) under System Settings > Privacy & Security > Accessibility.",
  screen_permission:
    "The Mac shows no screen until you allow PocketDesk (it may be listed as node) under System Settings > Privacy & Security > Screen Recording. The picture starts by itself once allowed.",
};
// A helper that never started (a script that fails to compile, PowerShell blocked) used to answer a
// bare "helper_not_running"; carry what it printed on stderr so the reason reaches the viewer.
export const inputError = (e, detail) => {
  const base = e === "elevated_window" || e === "input_blocked" ? ELEVATED : MAC_HELP[e] || e;
  return detail ? `${base}: ${detail}` : base;
};

export class InputController extends EventEmitter {
  /** @type {any} */ helperInput = null;
  /** @type {any} */ helperCapture = null;
  /** @type {any} */ helperClip = null;
  /** @type {any} */ linux = null;
  /** @type {any} */ origin = null;
  /** @type {any} */ monitorList = null;
  /** @type {Set<string> | null} */ clipHolders = null;
  /** @type {number | null} */ clipSeq = null;

  /** x/y: from the top-left monitor's corner, in pixels (points on macOS) (omit to act at the cursor); click: left|right|middle|double; press: down|up of button. */
  get _input() {
    return IS_MAC ? this.helperCapture : this.helperInput;
  }

  get _clip() {
    return IS_MAC ? this.helperCapture : this.helperClip;
  }

  async _inject(cmd, timeoutMs) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._input.ensure();
    const r = await this._input.cmd(cmd, timeoutMs);
    // The Accessibility prompt is shown once; macOS applies a grant without a restart.
    if (r?.error === "accessibility_permission" && !this._axRequested) {
      this._axRequested = true;
      /** @type {any} */ (this).requestPermissions().catch(() => {});
    }
    return { ok: !!r?.ok, error: inputError(r?.error) };
  }

  /** wheel: positive scrolls up; hwheel: positive scrolls right (Windows convention, both in 120ths of a notch).
   * @param {{x?: number, y?: number, click?: any, press?: any, button?: any, wheel?: any, hwheel?: any}} args
   */
  async inputMouse({ x, y, click, press, button, wheel, hwheel }) {
    if (this.linux) return this.linux.mouse({ x, y, click, press, button, wheel, hwheel });
    if (IS_MAC && x != null) {
      if (!this.monitorList) await /** @type {any} */ (this).monitors();
      x += this.origin.x;
      y += this.origin.y;
    }
    return this._inject({ op: "mouse", x, y, click, press, button, wheel, hwheel }, 8000);
  }

  /** Moves the pointer by dx/dy pixels, as a touchpad does; Windows applies its own pointer speed. */
  async inputMove(dx, dy) {
    if (IS_WIN) return this._inject({ op: "mouse", dx: Math.round(dx), dy: Math.round(dy) }, 8000);
    const p = await this.pointer();
    if (!p) return { ok: false, error: "no_pointer" };
    return this.inputMouse({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
  }

  /** What a still frame shows, in input coordinates; null until the monitors are known. */
  get frameRect() {
    return jpegRect(this.monitorList);
  }

  /** press: down|up sends only that half, for held keys; without it the key is tapped with modifiers. */
  inputKey({ key, modifiers = [], press }) {
    const vk = Number(key);
    if (!Number.isFinite(vk) || vk <= 0 || vk > 254) return Promise.resolve({ ok: false, error: "bad_vk" });
    const mods = (Array.isArray(modifiers) ? modifiers : []).filter((m) =>
      ["ctrl", "alt", "shift", "win"].includes(m),
    );
    if (this.linux) return this.linux.key({ key: vk, modifiers: mods, press });
    return this._inject({ op: "key", key: vk, press, mods }, 8000);
  }

  inputType(text) {
    if (this.linux) return this.linux.type(text);
    return this._inject({ op: "type", text: String(text).slice(0, 512) }, 10000);
  }

  /** The pointer now, in the same space as input, or null. */
  async pointer() {
    if (this.linux) return this.linux.pointer();
    if (!IS_WIN && !IS_MAC) return null;
    await this._input.ensure();
    const r = await this._input.cmd({ op: "cursor" }, 2000);
    return r?.ok
      ? { x: r.x - this.origin.x, y: r.y - this.origin.y, shape: r.shape, visible: r.visible }
      : null;
  }

  /** macOS only: locks the screen at once; { ok:false } elsewhere or when it did not lock. */
  async lockScreen() {
    if (!IS_MAC) return { ok: false };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "lock" }, 8000);
  }

  /** Polls the pointer while anyone watches and emits "cursor" when it moves or changes shape. */
  watchCursor(on) {
    const usable = /** @type {any} */ (this).usable;
    if (!on || !usable) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
      return;
    }
    if (this.cursorTimer) return;
    let busy = false;
    let last = "";
    // xdotool spawns a process per poll, so Linux polls far slower than the native Win/Mac helpers.
    this.cursorTimer = setInterval(
      async () => {
        if (busy) return;
        busy = true;
        try {
          const c = await this.pointer();
          const key = JSON.stringify(c);
          if (c && key !== last) {
            last = key;
            this.cursor = c;
            this.emit("cursor", c);
          }
        } finally {
          busy = false;
        }
      },
      this.linux ? 120 : 33,
    );
  }

  /** { kind: text|image|files|empty, ... }; images above maxImage bytes come back without png. */
  async clipboardRead(maxImage = 12 << 20) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._clip.ensure();
    const r = await this._clip.cmd({ op: "read", maxImage }, 15000);
    if (r?.ok) this.clipSeq = r.seq;
    return r?.ok ? r : { ok: false, error: r?.error || "clipboard_failed" };
  }

  /** Any of text, png (base64) and files (absolute paths) in one clipboard entry. */
  async clipboardSet({ text, png, files }) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._clip.ensure();
    const r = await this._clip.cmd({ op: "set", text, png, files }, 15000);
    // Our own write must not come back to the viewer as a PC-side change.
    if (r?.ok) this.clipSeq = r.seq;
    return { ok: !!r?.ok, error: r?.error };
  }

  /**
   * While anyone holds it on, emits "clipboard" with the new content whenever something on the PC
   * copies. [who] keeps desktop viewers and phone clipboard sync from switching each other off.
   */
  watchClipboard(on, who = "viewer") {
    (this.clipHolders ||= new Set())[on ? "add" : "delete"](who);
    if (!this.clipHolders.size || (!IS_WIN && !IS_MAC)) {
      clearInterval(this.clipTimer);
      this.clipTimer = null;
      return;
    }
    if (this.clipTimer) return;
    let busy = false;
    this.clipTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this._clip.ensure();
        const r = await this._clip.cmd({ op: "seq" }, 5000);
        if (!r?.ok) return;
        if (this.clipSeq == null) {
          this.clipSeq = r.seq;
          return;
        }
        if (r.seq === this.clipSeq) return;
        const c = await this.clipboardRead();
        if (c.ok && c.kind !== "empty") this.emit("clipboard", c);
      } finally {
        busy = false;
      }
    }, 500);
  }
}
