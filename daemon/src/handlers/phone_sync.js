// SPDX-License-Identifier: GPL-3.0-or-later
// What flows between this PC and the phone by itself once its owner turns it on: the clipboard
// both ways (text through phone control or the phone app, pictures through the phone app) and
// this PC's notifications onto the phone. Settings live in ~/.pocketdesk/phone.json.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { PcNotifications } from "../pc_notifs.js";
import { bridge } from "./phone_adb.js";
import * as timeline from "../timeline.js";

const FILE = path.join(configDir, "phone.json");
const DEFAULTS = { clipSync: false, pcNotifs: false, muted: [] };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}

export default function phoneSyncHandlers(ctx) {
  const { send, desktop, clients = () => [] } = ctx;
  let cfg = load();
  const notifs = new PcNotifications();
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
    if (cfg.muted.includes(n.app)) return;
    for (const p of phones()) send(p, { type: "pc_notif", ...n });
    for (const w of viewers()) send(w, { type: "pc_notif", ...n });
  });

  timeline.onAdd((e) => { for (const w of viewers()) send(w, { type: "timeline_added", item: e }); });
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
      send(ws, { type: "phone_sync", ...cfg, pcNotifsSupported: notifs.supported, clipSupported: !!desktop && process.platform !== "linux" });
    },
    async phone_sync_set(ws, msg) {
      if (typeof msg.clipSync === "boolean") cfg.clipSync = msg.clipSync;
      if (typeof msg.pcNotifs === "boolean") cfg.pcNotifs = msg.pcNotifs;
      if (Array.isArray(msg.muted)) cfg.muted = msg.muted.filter((x) => typeof x === "string").slice(0, 200);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
      apply();
      for (const w of viewers()) send(w, { type: "phone_sync", ...cfg, pcNotifsSupported: notifs.supported, clipSupported: !!desktop && process.platform !== "linux" });
    },
    /** The phone app's own clipboard change (it can read it only while open on the phone). */
    async phone_clip(ws, msg) {
      if (!ws._android || !cfg.clipSync || typeof msg.text !== "string") return;
      bridge.onPhoneClip(msg.text);
    },
  };
}
