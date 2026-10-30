// The PC views and controls the phone. The phone owns consent: it starts and stops the share,
// and the daemon only relays its video to watchers and their input back to it.
const STALE_MS = 3000;
const PHONE_KIND = 16; // phone video kinds 16-30 sit apart from PC desktop kinds 0-3 on the same socket
// A rooted phone streams up to 3 extra live panes: byte = slot * 4 + kind, slot 0 being the screen itself.
const MAX_SLOT = 3;
// control: the phone has its accessibility service on, so input can act; off means view only.
const share = { phone: null, watchers: new Set(), w: 0, h: 0, control: false, active: null, apps: [] };

/** One phone video packet [slot * 4 + kind, ...annexB] from whichever socket sent it; only the sharing phone's are relayed. */
export function phoneBinary(ws, buf) {
  if (ws !== share.phone || !buf.length || (buf[0] & 3) > 2 || buf[0] >> 2 > MAX_SLOT) return;
  share.lastPacket = Date.now();
  const out = Buffer.from(buf);
  out[0] += PHONE_KIND;
  for (const w of share.watchers) {
    if (w.readyState !== 1) continue;
    if (buf[0] === 0) w._phoneNeedKey = false;
    if (w._phoneNeedKey) continue;
    // A backed-up watcher waits for a fresh keyframe, which the phone makes on request.
    if (w.bufferedAmount > 1_500_000) { w._phoneNeedKey = true; keyframe(); continue; }
    w.send(out);
  }
}

function keyframe() {
  if (share.phone?.readyState === 1) share.phone.send(JSON.stringify({ type: "phone_keyframe" }));
}

// Storage requests in flight: the daemon's id -> who asked and under which id.
const asked = new Map();
let nextAsk = 1;
import * as timeline from "../timeline.js";
import { toast } from "../toast.js";
import { syncSettings } from "./phone_sync.js";

const FS_OPS = new Set(["list", "read", "write", "mkdir", "delete", "rename"]);
// The newest event per phone service, for a PC page that opens later.
const hub = { last: new Map() };
// What each notification last said, so an update that changes nothing is not recorded twice.
const said = new Map();
let desktopRef = null;

function record(e) {
  if (e.svc === "notif" && e.op === "posted" && e.item) {
    const n = e.item, line = `${n.title || ""}${n.text || ""}`;
    if (said.get(n.key) === line) return;
    said.set(n.key, line);
    if (said.size > 500) said.delete(said.keys().next().value);
    timeline.add("notif", n.title || n.appName, n.text || "", { app: n.appName });
    const code = syncSettings().otpCopy && n.code;
    if (code) desktopRef?.clipboardSet({ text: n.code }).catch?.(() => {});
    if (syncSettings().phoneToasts && !n.silent && !syncSettings().muted.includes(n.app)) {
      toast({ title: n.title || n.appName, body: code ? `Code ${n.code} is on this PC's clipboard
${n.text || ""}` : n.text, app: n.appName, tag: n.key });
    }
  } else if (e.svc === "call" && e.state === "ringing") {
    timeline.add("call", e.name || "Incoming call", "Rang on the phone");
    if (syncSettings().phoneToasts) toast({ title: e.name || "Incoming call", body: "Your phone is ringing. Answer or decline on the Calls page.", app: "Phone", tag: "call", call: true });
  } else if (e.svc === "battery" && e.level <= 15 && !e.charging && hub.lowWarned !== true) {
    hub.lowWarned = true;
    if (syncSettings().phoneToasts) toast({ title: `Phone battery ${e.level}%`, body: "Plug it in soon.", app: "Phone", tag: "battery" });
  } else if (e.svc === "battery" && (e.charging || e.level > 20)) {
    hub.lowWarned = false;
  }
}

export default function phoneHandlers(ctx) {
  const { send, broadcast, clients = () => [] } = ctx;
  desktopRef = ctx.desktop;
  /** The phone answering storage requests: the sharing one, else the latest connected phone. */
  const storagePhone = () => (share.phone?.readyState === 1 ? share.phone
    : [...clients()].filter((w) => w._android && w._authed && w.readyState === 1).at(-1));
  function end() {
    if (!share.phone) return;
    share.phone = null;
    share.apps = [];
    share.active = null;
    for (const w of share.watchers) send(w, { type: "phone_stopped" });
    broadcast({ type: "swap", direction: "phone" });
  }
  function relay(ws, msg) {
    if (!share.phone) return send(ws, { type: "error", message: `${msg.type}: the phone is not shared` });
    if (!share.watchers.has(ws)) return send(ws, { type: "error", message: `${msg.type}: not watching the phone` });
    send(share.phone, msg);
  }
  return {
    async phone_watch(ws, msg = {}) {
      if (!share.watchers.has(ws)) {
        share.watchers.add(ws);
        ws.once?.("close", () => share.watchers.delete(ws));
      }
      ws._phoneNeedKey = true;
      // The encoder repeats frames on a still screen, so silence means the phone app died on a half-open socket.
      if (share.phone && Date.now() - share.lastPacket > STALE_MS) end();
      send(ws, { type: "phone_state", sharing: !!share.phone, w: share.w, h: share.h, control: share.control, active: share.active, apps: share.apps });
      if (share.phone) return keyframe();
      // Consent is the phone's: it asks its owner, then answers with phone_share_start.
      // A page that only opened (ask: false) listens for a share without prompting the phone.
      if (msg.ask !== false) broadcast({ type: "phone_share_request" });
    },
    async phone_unwatch(ws) {
      share.watchers.delete(ws);
    },
    async phone_share_start(ws, msg) {
      if (share.phone && share.phone !== ws) send(share.phone, { type: "phone_share_stop" });
      share.phone = ws;
      share.w = Number(msg.w) | 0;
      share.h = Number(msg.h) | 0;
      share.control = !!msg.control;
      share.lastPacket = Date.now();
      if (!ws._phoneCloseHooked) {
        ws._phoneCloseHooked = true;
        ws.once?.("close", () => { if (share.phone === ws) end(); });
      }
      for (const w of share.watchers) { w._phoneNeedKey = true; send(w, { type: "phone_started", w: share.w, h: share.h, control: share.control }); }
      broadcast({ type: "swap", direction: "pc" });
    },
    async phone_share_stop(ws) {
      if (share.phone === ws) end();
    },
    async phone_share_end(ws) {
      if (!share.phone) return;
      send(share.phone, { type: "phone_share_stop" });
      end();
    },
    async phone_apps(ws, msg) {
      if (share.phone !== ws) return;
      const slot = (n) => (Number.isInteger(n) && n >= 1 && n <= MAX_SLOT ? { slot: n } : {});
      const app = (a) => ({ pkg: String(a?.pkg || ""), label: String(a?.label || ""), ...slot(a?.slot) });
      // active is what the phone shows now (maybe the home screen); apps are the other recent ones.
      share.active = msg.active ? app(msg.active) : null;
      share.apps = (Array.isArray(msg.apps) ? msg.apps : []).slice(0, 20).map(app);
      for (const w of share.watchers) send(w, { type: "phone_apps", active: share.active, apps: share.apps });
    },
    async phone_input(ws, msg) {
      const { kind, fx, fy, tx, ty, ms, key, text, slot } = msg;
      relay(ws, { type: "phone_input", kind: String(kind), fx, fy, tx, ty, ms, key, text, slot });
    },
    // The phone's own storage, behind Android's "All files access" that its owner grants.
    async phone_fs(ws, msg) {
      const phone = storagePhone();
      if (!phone) return send(ws, { type: "phone_fs_result", rid: msg.rid, error: "the phone is not connected" });
      if (!FS_OPS.has(msg.op)) return send(ws, { type: "phone_fs_result", rid: msg.rid, error: `unknown op: ${msg.op}` });
      const id = nextAsk++;
      asked.set(id, { ws, rid: msg.rid, phone });
      setTimeout(() => asked.delete(id), 120_000).unref?.();
      const { op, path, to, offset, data, append } = msg;
      send(phone, { type: "phone_fs", rid: id, op, path: String(path ?? "/"), to, offset, data, append });
    },
    async phone_fs_result(ws, msg) {
      const a = asked.get(msg.rid);
      // Only the phone that was asked may answer; another paired phone could otherwise forge its files.
      if (!a || ws !== a.phone) return;
      asked.delete(msg.rid);
      send(a.ws, { ...msg, rid: a.rid });
    },
    async phone_switch(ws, msg) {
      relay(ws, { type: "phone_switch", pkg: String(msg.pkg || "") });
    },
    // The phone app's own features for the PC: notifications, texts, calls, contacts, quick
    // settings, media, battery, photos, ringing. One request in, one answer back to who asked.
    async phone_req(ws, msg) {
      const phone = storagePhone();
      if (!phone) return send(ws, { type: "phone_res", rid: msg.rid, ok: false, error: "the PocketDesk app on the phone is not connected" });
      if (phone === ws) return;
      if (!/^[a-z]{2,12}$/.test(String(msg.svc)) || !/^[a-z_]{2,20}$/.test(String(msg.op))) return send(ws, { type: "phone_res", rid: msg.rid, ok: false, error: "bad request" });
      const id = nextAsk++;
      asked.set(id, { ws, rid: msg.rid, phone });
      setTimeout(() => asked.delete(id), 120_000).unref?.();
      if (msg.svc === "sms" && msg.op === "send") timeline.add("sms", `To ${String(msg.address || "")}`, String(msg.text || (msg.image ? "Picture" : "")));
      if (msg.svc === "calls" && msg.op === "dial") timeline.add("call", `Called ${String(msg.number || "")}`, "from this PC");
      send(phone, { ...msg, type: "phone_req", rid: id });
    },
    async phone_res(ws, msg) {
      const a = asked.get(msg.rid);
      if (!a || ws !== a.phone) return;
      asked.delete(msg.rid);
      send(a.ws, { ...msg, rid: a.rid });
    },
    /** Something changed on the phone (a notification, a call, a text, a toggle): every PC viewer hears it. */
    async phone_evt(ws, msg) {
      if (!ws._android || !/^[a-z]{2,12}$/.test(String(msg.svc))) return;
      hub.last.set(msg.svc, msg);
      record(msg);
      for (const w of clients()) if (w._authed && !w._android) send(w, msg);
    },
    /** The phone asks the PC pages to open its screen (phone control, else the app's own share). */
    async phone_show(ws) {
      if (!ws._android) return;
      for (const w of clients()) if (w._authed && !w._android) send(w, { type: "phone_show" });
    },
    /** A PC page opening: the phone's last known state, and whether its app is there to ask. */
    async phone_hub(ws) {
      send(ws, { type: "phone_hub", online: !!storagePhone(), name: storagePhone()?._name || null, last: Object.fromEntries(hub.last) });
    },
  };
}
