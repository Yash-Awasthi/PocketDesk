// SPDX-License-Identifier: GPL-3.0-or-later
// What flows between this PC and the phone by itself once its owner turns it on: the clipboard
// both ways (text through phone control or the phone app, pictures through the phone app) and
// this PC's notifications onto the phone. Settings live in ~/.pocketdesk/phone.json.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { resolvePath } from "../fs_ops.js";
import { PcNotifications } from "../pc_notifs.js";
import { Hotkeys } from "../hotkeys.js";
import { bridge } from "./phone_adb.js";
import * as timeline from "../timeline.js";
import { ours, toast } from "../toast.js";

const FILE = path.join(configDir, "phone.json");
const DEFAULTS = { clipSync: false, pcNotifs: false, phoneToasts: process.platform === "win32", otpCopy: false, hotkeys: false, muted: [] };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}

// Read by the phone handler, which shows toasts for the phone's events.
let live = load();
export const syncSettings = () => live;

export default function phoneSyncHandlers(ctx) {
  const { send, desktop, clients = () => [] } = ctx;
  let cfg = live;
  const notifs = new PcNotifications();
  const hotkeys = new Hotkeys();
  const phones = () => [...clients()].filter((w) => w._authed && w._android && w.readyState === 1);
  const viewers = () => [...clients()].filter((w) => w._authed && !w._android && w.readyState === 1);
  // Texts that crossed either way lately: the phone reports back what it was given (and answers
  // every clipboard read), and none of that may land on the PC again as a new copy.
  const crossed = new Map();
  const recent = (t) => { const at = crossed.get(t); return at && Date.now() - at < 60_000; };
  const mark = (t) => { crossed.set(t, Date.now()); if (crossed.size > 20) crossed.delete(crossed.keys().next().value); };
  let keepTimer = null;

  function apply() {
    desktop?.watchClipboard(cfg.clipSync, "phone");
    clearInterval(keepTimer);
    keepTimer = null;
    if (cfg.clipSync) {
      // Phone control's clipboard stream needs a session; one that dropped (phone asleep, cable out) is reopened.
      const keep = () => bridge.ready() && bridge.keep?.().catch(() => {});
      keep();
      keepTimer = setInterval(keep, 15_000);
      keepTimer.unref?.();
    }
    notifs.watch(cfg.pcNotifs && notifs.supported);
    if (cfg.hotkeys) hotkeys.start(); else hotkeys.stop();
  }

  desktop?.on("clipboard", async (c) => {
    if (!cfg.clipSync) return;
    if (c.kind === "text" && c.text && !recent(c.text)) {
      mark(c.text);
      timeline.add("clip", "Copied to the phone", c.text);
      if (bridge.ready()) await bridge.setClipboard?.(c.text.slice(0, 200_000)).catch(() => {});
      else for (const p of phones()) send(p, { type: "pc_clip", text: c.text.slice(0, 200_000) });
    } else if (c.kind === "image" && c.png) {
      for (const p of phones()) send(p, { type: "pc_clip", png: c.png });
    }
  });

  bridge.onPhoneClip = (text) => {
    if (!cfg.clipSync || !text || recent(text)) return;
    mark(text);
    timeline.add("clip", "Copied from the phone", text);
    desktop?.clipboardSet({ text }).catch?.(() => {});
  };

  notifs.on("notification", (n) => {
    if (cfg.muted.includes(n.app) || ours(n.title, n.body)) return;
    for (const p of phones()) send(p, { type: "pc_notif", ...n });
    for (const w of viewers()) send(w, { type: "pc_notif", ...n });
  });

  timeline.onAdd((e) => { for (const w of viewers()) send(w, { type: "timeline_added", item: e }); });

  // Ctrl+Alt+C sends what is selected in Explorer to the phone; Ctrl+Alt+V pastes what the phone copied.
  let copied = [];
  hotkeys.on("copy", async (files) => {
    if (!cfg.hotkeys) return;
    if (!files.length) return toast({ title: "Nothing to copy", body: "Select files in File Explorer, then press Ctrl+Alt+C.", app: "PocketDesk", tag: "pd-hk" });
    if (bridge.ready()) {
      toast({ title: `Sending ${files.length} item${files.length > 1 ? "s" : ""} to the phone`, body: "They land in its Downloads.", app: "PocketDesk", tag: "pd-hk" });
      for (const f of files) await bridge.pushFile(f).catch((e) => toast({ title: "Could not send a file", body: `${path.basename(f)}: ${e.message}`, app: "PocketDesk", tag: "pd-hk" }));
      return;
    }
    const list = files.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
      .map((f) => ({ path: f, name: path.basename(f), size: fs.statSync(f).size }));
    if (!phones().length) return toast({ title: "The phone is not connected", body: "Open PocketDesk on the phone, or set up phone control.", app: "PocketDesk", tag: "pd-hk" });
    if (!list.length) return toast({ title: "Only files go through the phone app", body: "Folders need phone control (Connect page).", app: "PocketDesk", tag: "pd-hk" });
    for (const p of phones()) send(p, { type: "pc_files", files: list });
    for (const f of list) timeline.add("file", f.name, "Sent to the phone's Downloads");
    toast({ title: `Sending ${list.length} file${list.length > 1 ? "s" : ""} to the phone`, body: "They land in its Downloads.", app: "PocketDesk", tag: "pd-hk" });
  });
  hotkeys.on("paste", async () => {
    if (!cfg.hotkeys) return;
    const files = copied.filter((f) => fs.existsSync(f));
    if (!files.length) return toast({ title: "Nothing copied on the phone", body: "On the phone, share files to \"Copy to PC\", then press Ctrl+Alt+V here.", app: "PocketDesk", tag: "pd-hk" });
    const r = await desktop?.clipboardSet({ files });
    if (r?.ok) await desktop.inputKey({ key: 86, modifiers: ["ctrl"] });
  });
  apply();

  return {
    async timeline_list(ws, msg) {
      send(ws, { type: "timeline", items: timeline.list({ q: msg.q, kind: msg.kind, limit: Math.min(1000, Number(msg.limit) || 300) }) });
    },
    async timeline_clear(ws) {
      timeline.clear();
      for (const w of viewers()) send(w, { type: "timeline", items: [] });
    },
    async phone_sync_get(ws) {
      send(ws, { type: "phone_sync", ...cfg, pcNotifsSupported: notifs.supported, hotkeysSupported: hotkeys.supported, clipSupported: !!desktop && process.platform !== "linux" });
    },
    async phone_sync_set(ws, msg) {
      if (typeof msg.clipSync === "boolean") cfg.clipSync = msg.clipSync;
      if (typeof msg.pcNotifs === "boolean") cfg.pcNotifs = msg.pcNotifs;
      if (typeof msg.phoneToasts === "boolean") cfg.phoneToasts = msg.phoneToasts;
      if (typeof msg.otpCopy === "boolean") cfg.otpCopy = msg.otpCopy;
      if (typeof msg.hotkeys === "boolean") cfg.hotkeys = msg.hotkeys;
      if (Array.isArray(msg.muted)) cfg.muted = msg.muted.filter((x) => typeof x === "string").slice(0, 200);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
      apply();
      for (const w of viewers()) send(w, { type: "phone_sync", ...cfg, pcNotifsSupported: notifs.supported, hotkeysSupported: hotkeys.supported, clipSupported: !!desktop && process.platform !== "linux" });
    },
    /** The phone app's own clipboard change (it can read it only while open on the phone). */
    async phone_clip(ws, msg) {
      if (!ws._android) return;
      // A picture sent on purpose (a photo or scan from the phone) lands even with sync off.
      if (typeof msg.png === "string" && (cfg.clipSync || msg.paste)) {
        const r = await desktop?.clipboardSet({ png: msg.png.slice(0, 24 << 20) });
        timeline.add("clip", "Picture from the phone", msg.paste ? "On this PC's clipboard, ready to paste" : "Copied on the phone");
        if (msg.paste && r?.ok) toast({ title: "Picture from your phone", body: "It is on the clipboard: paste it anywhere with Ctrl+V.", app: "PocketDesk", tag: "pd-photo" });
        return;
      }
      if (!cfg.clipSync || typeof msg.text !== "string") return;
      bridge.onPhoneClip(msg.text);
    },
    /** Files the phone uploaded with "Copy to PC": on this PC's clipboard now, and pasted by Ctrl+Alt+V. */
    async phone_copied(ws, msg) {
      if (!ws._android || !Array.isArray(msg.files)) return;
      const files = [];
      for (const f of msg.files.slice(0, 100)) { try { const p = resolvePath(String(f)); if (fs.existsSync(p)) files.push(p); } catch {} }
      if (!files.length) return;
      copied = files;
      await desktop?.clipboardSet({ files });
      for (const f of files) timeline.add("file", path.basename(f), "Copied from the phone");
      toast({ title: `${files.length} file${files.length > 1 ? "s" : ""} copied from the phone`, body: cfg.hotkeys ? "Paste with Ctrl+V, or Ctrl+Alt+V straight into the app in front." : "Paste with Ctrl+V.", app: "PocketDesk", tag: "pd-hk" });
    },
  };
}
