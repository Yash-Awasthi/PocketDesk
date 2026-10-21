// The PC views and controls the phone. The phone owns consent: it starts and stops the share,
// and the daemon only relays its video to watchers and their input back to it.
const STALE_MS = 3000;
const PHONE_KIND = 16; // phone video kinds 16-18 sit apart from PC desktop kinds 0-3 on the same socket
// control: the phone has its accessibility service on, so input can act; off means view only.
const share = { phone: null, watchers: new Set(), w: 0, h: 0, control: false, active: null, apps: [] };

/** One phone video packet [kind, ...annexB] from whichever socket sent it; only the sharing phone's are relayed. */
export function phoneBinary(ws, buf) {
  if (ws !== share.phone || !buf.length || buf[0] > 2) return;
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
const FS_OPS = new Set(["list", "read", "write", "mkdir", "delete", "rename"]);

export default function phoneHandlers(ctx) {
  const { send, broadcast, clients = () => [] } = ctx;
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
    async phone_watch(ws) {
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
      broadcast({ type: "phone_share_request" });
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
      const app = (a) => ({ pkg: String(a?.pkg || ""), label: String(a?.label || "") });
      // active is what the phone shows now (maybe the home screen); apps are the other recent ones.
      share.active = msg.active ? app(msg.active) : null;
      share.apps = (Array.isArray(msg.apps) ? msg.apps : []).slice(0, 20).map(app);
      for (const w of share.watchers) send(w, { type: "phone_apps", active: share.active, apps: share.apps });
    },
    async phone_input(ws, msg) {
      const { kind, fx, fy, tx, ty, ms, key, text } = msg;
      relay(ws, { type: "phone_input", kind: String(kind), fx, fy, tx, ty, ms, key, text });
    },
    // The phone's own storage, behind Android's "All files access" that its owner grants.
    async phone_fs(ws, msg) {
      const phone = storagePhone();
      if (!phone) return send(ws, { type: "phone_fs_result", rid: msg.rid, error: "the phone is not connected" });
      if (!FS_OPS.has(msg.op)) return send(ws, { type: "phone_fs_result", rid: msg.rid, error: `unknown op: ${msg.op}` });
      const id = nextAsk++;
      asked.set(id, { ws, rid: msg.rid });
      setTimeout(() => asked.delete(id), 120_000).unref?.();
      const { op, path, to, offset, data, append } = msg;
      send(phone, { type: "phone_fs", rid: id, op, path: String(path ?? "/"), to, offset, data, append });
    },
    async phone_fs_result(ws, msg) {
      const a = asked.get(msg.rid);
      if (!ws._android || !a) return;
      asked.delete(msg.rid);
      send(a.ws, { ...msg, rid: a.rid });
    },
    async phone_switch(ws, msg) {
      relay(ws, { type: "phone_switch", pkg: String(msg.pkg || "") });
    },
  };
}
