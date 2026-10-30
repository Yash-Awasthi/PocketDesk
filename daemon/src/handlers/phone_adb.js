// SPDX-License-Identifier: GPL-3.0-or-later
// The PC drives the phone over adb: its screen with real touch, mouse, keys and sound, any app in
// a window of its own on a virtual display, its cameras, clipboard and files. scrcpy-server runs on
// the phone as the shell user once wireless debugging (or a USB cable) is set up; no root, no
// accessibility service. Design follows TwinDesk's phone bridge (GPL-3.0).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTools, findAdb, serverPath } from "../phone_adb/tools.js";
import { Adb } from "../phone_adb/adb.js";
import { startAdbQr } from "../phone_adb/adbqr.js";
import { Session, ACTION, TYPE } from "../phone_adb/scrcpy.js";
import { KeyState, ANDROID } from "../phone_adb/android_keys.js";

// Binary to the viewer: [kind, view id, flags, pts f64 (µs), ...data]; kinds sit apart from the
// PC desktop's 0-3 and the phone app's 16-30 on the same socket.
export const BIN_VIDEO = 0x40;
export const BIN_AUDIO = 0x41;
const HEAD = 11;
const MAX_VIEWS = 8;
const BEHIND = 2_000_000;
const CHATS = new Set(["com.whatsapp", "com.whatsapp.w4b", "com.instagram.android", "org.telegram.messenger", "org.telegram.messenger.web", "org.thoughtcrime.securesms"]);

const st = { adb: null, serial: null, error: "", qr: null, apps: new Map(), clip: null, views: new Map() };
let nextView = 1;

function packet(kind, id, flags, pts, data) {
  const b = Buffer.allocUnsafe(HEAD + data.length);
  b[0] = kind; b[1] = id; b[2] = flags;
  b.writeDoubleBE(pts || 0, 3);
  data.copy(b, HEAD);
  return b;
}

export default function phoneAdbHandlers(ctx) {
  const { send, clients = () => [] } = ctx;
  const viewers = () => [...clients()].filter((w) => w._authed && !w._android && w.readyState === 1);

  async function adb() {
    if (st.adb) return st.adb;
    const { adb: bin, server } = await ensureTools();
    st.adb = new Adb(bin, server);
    return st.adb;
  }

  /** Devices adb sees, after trying every wireless-debugging phone this PC has paired before. */
  async function devices({ reconnect = false } = {}) {
    const a = await adb();
    let list = await a.devices();
    if (reconnect && !list.some((d) => d.state === "device")) {
      for (const s of (await a.mdns()).filter((x) => x.type === "connect")) await a.connect(s.address, s.port);
      list = await a.devices();
    }
    const ready = list.filter((d) => d.state === "device");
    if (!ready.some((d) => d.serial === st.serial)) st.serial = ready.find((d) => !d.wireless)?.serial || ready[0]?.serial || null;
    return list;
  }

  async function state(reconnect) {
    const toolsReady = !!findAdb() && fs.existsSync(serverPath());
    let list = [];
    if (toolsReady || st.adb) {
      try { list = await devices({ reconnect }); st.error = ""; } catch (e) { st.error = e.message; }
    }
    const cur = list.find((d) => d.serial === st.serial);
    return {
      type: "adb_state", toolsReady, error: st.error, devices: list, serial: st.serial,
      via: cur ? (cur.wireless ? "wifi" : "usb") : null, model: cur?.model || null, pairing: !!st.qr,
      views: [...st.views.values()].map(viewInfo),
    };
  }

  const viewInfo = (v) => ({ id: v.id, kind: v.kind, pkg: v.pkg || null, label: v.label, w: v.size?.width || 0, h: v.size?.height || 0, codec: v.session?.videoCodec || null, error: v.error || "" });
  const tellAll = async () => { const s = await state(false); for (const w of viewers()) send(w, s); };

  function needSerial() {
    if (!st.serial) throw new Error("no phone: set up wireless debugging or plug in a USB cable");
    return st.serial;
  }

  async function open(ws, m) {
    const serial = needSerial();
    if (st.views.size >= MAX_VIEWS) throw new Error(`at most ${MAX_VIEWS} phone windows`);
    const kind = ["screen", "app", "camera", "sound"].includes(m.kind) ? m.kind : "screen";
    if (kind === "app" && !/^[\w.]+$/.test(String(m.pkg || ""))) throw new Error("app: package name required");
    const reuse = [...st.views.values()].find((v) => v.owner === ws && v.kind === kind && (kind !== "app" || v.pkg === m.pkg));
    if (reuse && kind !== "camera") { send(ws, { type: "adb_view", ...viewInfo(reuse) }); reuse.session?.simple(TYPE.RESET_VIDEO); return; }
    const codec = ["h264", "h265", "av1"].includes(m.codec) ? m.codec : "h264";
    const base = { video: kind !== "sound", control: kind !== "sound", maxFps: Math.min(120, Number(m.fps) || 60), videoBitRate: Math.min(40, Number(m.mbps) || 8) * 1e6, videoCodec: codec };
    let opts;
    if (kind === "screen") opts = { ...base, audio: !!m.audio, maxSize: Number(m.maxSize) | 0, stayAwake: true, clipboardAutosync: true };
    else if (kind === "sound") opts = { video: false, control: false, audio: true };
    else if (kind === "camera") {
      opts = { ...base, audio: false, videoSource: "camera", cameraFacing: m.facing === "front" ? "front" : "back", cameraFps: 30, maxSize: 1920 };
      if (/^\d{2,5}x\d{2,5}$/.test(String(m.size || ""))) opts.cameraSize = m.size;
    } else {
      const w = Math.max(240, Math.min(3840, Number(m.w) | 0 || 824)), h = Math.max(240, Math.min(3840, Number(m.h) | 0 || 1720));
      const dpi = Math.max(120, Math.min(640, Number(m.dpi) | 0 || 320));
      opts = { ...base, audio: false, flex: true, newDisplay: `${w & ~1}x${h & ~1}/${dpi}` };
    }
    let id;
    do id = (nextView++ % 250) + 1; while (st.views.has(id));
    const v = { id, kind, pkg: kind === "app" ? m.pkg : null, label: String(m.label || m.pkg || kind).slice(0, 80), owner: ws, keys: new KeyState(), size: null, needKey: true, screenOff: false, torch: false, facing: opts.cameraFacing };
    st.views.set(id, v);
    if (!ws._adbHooked) { ws._adbHooked = true; ws.once?.("close", () => { for (const x of [...st.views.values()]) if (x.owner === ws) close(x); }); }
    send(ws, { type: "adb_view", ...viewInfo(v) });
    try { await start(v, serial, opts); } catch (e) {
      v.error = e.message;
      send(ws, { type: "adb_view_closed", id, why: e.message });
      st.views.delete(id);
    }
  }

  async function start(v, serial, opts) {
    const s = new Session(await adb(), serial, opts);
    v.session = s;
    const ws = v.owner;
    s.on("size", (size) => { v.size = size; send(ws, { type: "adb_view", ...viewInfo(v) }); });
    s.on("video", (p) => {
      if (ws.readyState !== 1) return;
      if (p.config) v.needKey = true;
      else if (p.key) v.needKey = false;
      else if (v.needKey) return;
      // A viewer that fell behind skips to a fresh keyframe rather than smearing.
      if (!p.config && ws.bufferedAmount > BEHIND) { v.needKey = true; s.simple(TYPE.RESET_VIDEO); return; }
      ws.send(packet(BIN_VIDEO, v.id, (p.config ? 1 : 0) | (p.key ? 2 : 0), p.pts, p.data));
    });
    s.on("audioCodec", (c) => send(ws, { type: "adb_audio", id: v.id, codec: c === 0x6f707573 ? "opus" : c === 0x00726177 ? "raw" : c <= 1 ? null : "other" }));
    s.on("audio", (p) => { if (ws.readyState === 1 && ws.bufferedAmount < BEHIND) ws.send(packet(BIN_AUDIO, v.id, p.config ? 1 : 0, p.pts, p.data)); });
    s.on("clipboard", (text) => { for (const w of viewers()) send(w, { type: "adb_clipboard", text }); });
    s.on("closed", (why) => {
      if (v.session !== s) return;
      st.views.delete(v.id);
      send(ws, { type: "adb_view_closed", id: v.id, why });
    });
    await s.start();
    if (v.pkg) setTimeout(() => s.startApp(v.pkg), 300);
  }

  function close(v) {
    st.views.delete(v.id);
    const s = v.session;
    v.session = null;
    if (s && !s.closed) {
      if (v.screenOff) try { s.setDisplayPower(true); } catch {}
      s.stop();
    }
  }

  /** One control session for input with no window: typing on the phone, clipboard. */
  async function control() {
    const live = [...st.views.values()].find((v) => v.session && !v.session.closed && v.session.control && v.kind === "screen");
    if (live) return live.session;
    if (st.clip && !st.clip.closed) return st.clip;
    const s = new Session(await adb(), needSerial(), { video: false, audio: false, control: true, clipboardAutosync: true });
    st.clip = s;
    s.on("clipboard", (text) => { for (const w of viewers()) send(w, { type: "adb_clipboard", text }); });
    s.on("closed", () => { if (st.clip === s) st.clip = null; });
    await s.start();
    return s;
  }

  function input(v, m) {
    const s = v.session;
    if (!s || s.closed) return;
    const num = (x) => (Number.isFinite(x) ? x : 0);
    const size = v.size;
    if (v.kind === "camera") {
      if (m.t !== "camera") return;
      if (m.what === "torch") { v.torch = !v.torch; s.setTorch(v.torch); }
      else if (m.what === "zoomIn") s.zoomIn();
      else if (m.what === "zoomOut") s.zoomOut();
      return;
    }
    switch (m.t) {
      case "touch":
        if (!size) return;
        s.touch(m.action | 0, Math.max(-3, Math.min(9, m.pointer | 0)), num(m.x), num(m.y), size.width, size.height,
          m.action === ACTION.UP ? 0 : 1, m.actionButton | 0, m.buttons | 0);
        break;
      case "scroll":
        if (size) s.scroll(num(m.x), num(m.y), size.width, size.height, num(m.hs), num(m.vs), 0);
        break;
      case "key": {
        if (typeof m.code !== "string") return;
        // Enter sends in chat apps; Shift+Enter is a new line there.
        if ((m.code === "Enter" || m.code === "NumpadEnter") && m.down && m.enterSends !== false && CHATS.has(v.pkg)) {
          if (v.keys.held.has("ShiftLeft") || v.keys.held.has("ShiftRight")) { s.text("\n"); return; }
        }
        const e = v.keys.event(m.code, !!m.down);
        if (e) s.key(m.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, m.repeat ? 1 : 0);
        break;
      }
      case "text":
        if (typeof m.text === "string" && m.text) s.text(m.text.slice(0, 300));
        break;
      case "nav": {
        const k = { home: ANDROID.HOME, recents: ANDROID.APP_SWITCH, power: ANDROID.POWER, volumeUp: ANDROID.VOLUME_UP, volumeDown: ANDROID.VOLUME_DOWN, mute: ANDROID.VOLUME_MUTE, menu: ANDROID.MENU, allApps: ANDROID.ALL_APPS }[m.key];
        if (m.key === "back") { s.backOrScreenOn(ACTION.DOWN); s.backOrScreenOn(ACTION.UP); }
        else if (k) s.tap(k);
        else if (m.key === "notifications") s.simple(TYPE.EXPAND_NOTIFICATIONS);
        else if (m.key === "settings") s.simple(TYPE.EXPAND_SETTINGS);
        else if (m.key === "collapse") s.simple(TYPE.COLLAPSE_PANELS);
        else if (m.key === "rotate") s.simple(TYPE.ROTATE);
        else if (m.key === "screenPower" && v.kind === "screen") {
          v.screenOff = !v.screenOff;
          s.setDisplayPower(!v.screenOff);
          send(v.owner, { type: "adb_view_opts", id: v.id, screenOff: v.screenOff });
        }
        break;
      }
      case "resetVideo": s.simple(TYPE.RESET_VIDEO); break;
      case "resize": if (v.kind === "app") s.resizeDisplay(num(m.w), num(m.h)); break;
      case "paste": if (typeof m.text === "string") s.setClipboard(m.text, true); break;
    }
  }

  const err = (ws, op, e) => send(ws, { type: "adb_error", op, message: e?.message || String(e) });
  const viewOf = (ws, id) => { const v = st.views.get(Number(id)); return v && v.owner === ws ? v : null; };

  return {
    async adb_state(ws, msg) {
      try { send(ws, await state(!!msg.reconnect)); } catch (e) { err(ws, "state", e); }
    },
    async adb_setup(ws) {
      try { await adb(); send(ws, await state(true)); } catch (e) { err(ws, "setup", e); }
    },
    async adb_select(ws, msg) {
      const list = await devices().catch(() => []);
      if (list.some((d) => d.serial === msg.serial && d.state === "device")) st.serial = msg.serial;
      send(ws, await state(false));
    },
    async adb_pair(ws, msg) {
      try {
        const a = await adb();
        const r = await a.pair(String(msg.host), Number(msg.port), String(msg.code));
        if (!r.ok) throw new Error(r.text.split("\n").pop() || "pairing failed");
        // The connect port differs from the pairing one; the phone announces it over mDNS.
        for (let i = 0; i < 6 && !(await devices({ reconnect: true })).some((d) => d.state === "device"); i++) await new Promise((r) => setTimeout(r, 1000));
        await tellAll();
      } catch (e) { err(ws, "pair", e); }
    },
    async adb_connect(ws, msg) {
      try {
        const r = await (await adb()).connect(String(msg.host), Number(msg.port) || 5555);
        if (!r.ok) throw new Error(r.text || "connect failed");
        await tellAll();
      } catch (e) { err(ws, "connect", e); }
    },
    async adb_qr_start(ws) {
      try {
        const a = await adb();
        st.qr?.stop();
        st.qr = startAdbQr({
          adb: a,
          onPaired: async () => {
            for (let i = 0; i < 8 && !(await devices({ reconnect: true })).some((d) => d.state === "device"); i++) await new Promise((r) => setTimeout(r, 1000));
            await tellAll();
          },
          onEnd: (why) => {
            st.qr = null;
            for (const w of viewers()) send(w, { type: "adb_qr_end", why });
          },
        });
        send(ws, { type: "adb_qr", text: st.qr.text });
      } catch (e) { err(ws, "qr", e); }
    },
    async adb_qr_stop() { st.qr?.stop(); },
    async adb_disconnect(ws) {
      if (st.serial) await (await adb()).disconnect(st.serial);
      for (const v of [...st.views.values()]) close(v);
      st.serial = null;
      await tellAll();
    },
    async adb_open(ws, msg) {
      try { await open(ws, msg); } catch (e) { err(ws, "open", e); }
    },
    async adb_close(ws, msg) {
      const v = viewOf(ws, msg.id);
      if (v) close(v);
    },
    async adb_input(ws, msg) {
      const v = viewOf(ws, msg.id);
      if (v) input(v, msg);
    },
    async adb_apps(ws, msg) {
      try {
        const serial = needSerial();
        if (msg.refresh || !st.apps.has(serial)) st.apps.set(serial, await Session.listApps(await adb(), serial));
        send(ws, { type: "adb_apps", apps: st.apps.get(serial) });
      } catch (e) { err(ws, "apps", e); }
    },
    async adb_cameras(ws) {
      try { send(ws, { type: "adb_cameras", cameras: await Session.listCameras(await adb(), needSerial()) }); } catch (e) { err(ws, "cameras", e); }
    },
    /** The PC's keyboard on the phone without a window: keys and text into whatever is in front. */
    async adb_type(ws, msg) {
      try {
        const s = await control();
        if (typeof msg.text === "string" && msg.text) s.text(msg.text.slice(0, 300));
        if (typeof msg.code === "string") {
          ws._adbKeys ||= new KeyState();
          const e = ws._adbKeys.event(msg.code, !!msg.down);
          if (e) s.key(msg.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, msg.repeat ? 1 : 0);
        }
      } catch (e) { err(ws, "type", e); }
    },
    async adb_clipboard_set(ws, msg) {
      try { (await control()).setClipboard(String(msg.text ?? "").slice(0, 200_000), !!msg.paste); } catch (e) { err(ws, "clipboard", e); }
    },
    async adb_clipboard_get(ws) {
      try { (await control()).getClipboard(); } catch (e) { err(ws, "clipboard", e); }
    },
    async adb_screenshot(ws) {
      try {
        const png = await (await adb()).screencap(needSerial());
        if (!png?.length) throw new Error("screenshot failed");
        send(ws, { type: "adb_screenshot", png: png.toString("base64") });
      } catch (e) { err(ws, "screenshot", e); }
    },
    /** A file from the PC into the phone's Downloads, in chunks; the last one pushes it. */
    async adb_push(ws, msg) {
      try {
        const name = path.basename(String(msg.name || "")).replace(/[\\/:*?"<>|]/g, "_");
        if (!name) throw new Error("name required");
        const tmp = path.join(os.tmpdir(), `pocketdesk-push-${ws._clientId || "x"}-${name}`);
        const data = Buffer.from(String(msg.data || ""), "base64");
        if (msg.offset) fs.appendFileSync(tmp, data); else fs.writeFileSync(tmp, data);
        if (!msg.last) return send(ws, { type: "adb_push", rid: msg.rid, ok: true });
        const remote = `/sdcard/Download/${name}`;
        const r = await (await adb()).push(needSerial(), tmp, remote);
        fs.rmSync(tmp, { force: true });
        if (r.code !== 0) throw new Error(r.err.trim() || r.out.trim() || "push failed");
        await (await adb()).shell(st.serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file://${remote.replace(/'/g, "")}'`, { timeout: 8000 });
        send(ws, { type: "adb_push", rid: msg.rid, ok: true, done: true, path: remote });
      } catch (e) { send(ws, { type: "adb_push", rid: msg.rid, ok: false, error: e.message }); }
    },
    /** Quick settings the shell user may change: Wi-Fi, Bluetooth, data, brightness, stay-awake, a URL. */
    async adb_action(ws, msg) {
      const cmds = {
        wifi_on: "svc wifi enable", wifi_off: "svc wifi disable",
        bt_on: "svc bluetooth enable", bt_off: "svc bluetooth disable",
        data_on: "svc data enable", data_off: "svc data disable",
        lock: "input keyevent 26", wake: "input keyevent 224", unlock_swipe: "input keyevent 82",
        rotate_auto: "settings put system accelerometer_rotation 1", rotate_lock: "settings put system accelerometer_rotation 0",
        dnd_on: "cmd notification set_dnd priority", dnd_off: "cmd notification set_dnd off",
      };
      try {
        const a = await adb(), serial = needSerial();
        let cmd = cmds[msg.action];
        if (msg.action === "brightness") cmd = `settings put system screen_brightness ${Math.max(0, Math.min(255, Number(msg.value) | 0))}`;
        if (msg.action === "volume") cmd = `cmd media_session volume --stream 3 --set ${Math.max(0, Math.min(25, Number(msg.value) | 0))}`;
        if (msg.action === "open_url") {
          const url = String(msg.value || "");
          if (!/^https?:\/\/[^\s'"]+$/.test(url)) throw new Error("http(s) URL required");
          cmd = `am start -a android.intent.action.VIEW -d '${url}'`;
        }
        if (msg.action === "battery") {
          const r = await a.shell(serial, "dumpsys battery", { timeout: 8000 });
          const get = (k) => new RegExp(`^\\s*${k}: (.+)$`, "m").exec(r.out)?.[1]?.trim();
          return send(ws, { type: "adb_action", action: "battery", level: Number(get("level")), charging: get("status") === "2" || get("AC powered") === "true" || get("USB powered") === "true", temp: Number(get("temperature")) / 10 });
        }
        if (!cmd) throw new Error(`unknown action: ${msg.action}`);
        const r = await a.shell(serial, cmd, { timeout: 10000 });
        send(ws, { type: "adb_action", action: msg.action, ok: r.code === 0, out: (r.out || r.err).trim().slice(0, 500) });
      } catch (e) { err(ws, "action", e); }
    },
  };
}
