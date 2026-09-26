import { resolvePath } from "../fs_ops.js";
import * as devices from "../devices.js";

export default function remoteHandlers(ctx) {
  const { send, desktop, desktopWatchers, video, videoWatchers, presence, recorder } = ctx;
  // Sockets that took a single snapshot stay on the PC's viewer bar for a few seconds.
  const snapshots = new Map();
  const deviceName = (ws) => devices.list().find((d) => d.id === ws._clientId)?.name || "A remote device";
  /** Pointer and clipboard follow the PC only while someone is viewing it, and the bar says who. */
  function syncCursor() {
    const on = videoWatchers.size + desktopWatchers.size > 0;
    desktop.watchCursor(on);
    desktop.watchClipboard(on);
    if (on && desktop.cursor) desktop.emit("cursor", desktop.cursor);
    const viewers = new Set([...videoWatchers, ...desktopWatchers, ...snapshots.keys()]);
    for (const w of viewers) if (!logged.has(w)) recorder.log("viewer_joined", { device: deviceName(w), viewOnly: !!w._viewOnly, snapshot: snapshots.has(w) && !videoWatchers.has(w) && !desktopWatchers.has(w) });
    for (const w of logged) if (!viewers.has(w)) recorder.log("viewer_left", { device: deviceName(w) });
    logged = viewers;
    recorder.screenWatched(on, { label: viewers.size ? deviceName([...viewers][0]) : "", monitor: video.monitor });
    presence.update([...viewers].map((w) => ({ name: deviceName(w), viewOnly: !!w._viewOnly })), recorder.recordingScreen);
    // Nobody left to drive the PC: hand the screen and input back to whoever sits at it.
    if (!on && presence.privacyOn) presence.setPrivacy(false);
  }
  let logged = new Set();
  /** With approval on, the person at the PC answers before a socket sees or touches anything. */
  async function approved(ws, wantsControl) {
    if (ws._desktopApproved || !presence.approvalRequired) return true;
    if (ws._asking) return false;
    ws._asking = true;
    send(ws, { type: "desktop_pending" });
    try {
      const answer = await presence.ask(`${deviceName(ws)} wants to ${wantsControl ? "view and control" : "view"} this PC.`);
      recorder.log(answer === "deny" ? "denied" : "approved", { device: deviceName(ws), answer });
      if (answer === "deny") return false;
      if (answer === "view") ws._viewOnly = ws._viewOnlyForced = true;
      ws._desktopApproved = true;
      return true;
    } finally { ws._asking = false; }
  }
  /** Input and clipboard writes: never from a view-only socket, never before approval. */
  function mayControl(ws) {
    return !ws._viewOnly && (ws._desktopApproved || !presence.approvalRequired);
  }
  if (presence) presence.onPrivacyChange = (on) => {
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) send(w, { type: "desktop_privacy", ok: true, on });
  };
  if (presence) presence.onDisconnect = () => {
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
      videoWatchers.delete(w);
      desktopWatchers.delete(w);
      desktop.stopFrameStream(w._clientId || "anon");
      w._desktopApproved = false;
      send(w, { type: "desktop_stopped", ok: true, reason: "ended on the PC" });
    }
    recorder.log("ended_on_pc");
    video.stop();
    syncCursor();
  };
  let monitorList = null;
  async function monitorAt(index) {
    if (!monitorList || !monitorList[index]) monitorList = (await desktop.monitors()).monitors || [];
    return monitorList[index] || null;
  }
  // A viewer that drops mid-press would leave the key or button stuck down on the PC.
  function hold(ws, id, press) {
    if (!ws._held) {
      ws._held = new Set();
      ws.once?.("close", () => {
        for (const h of ws._held) {
          const [kind, v] = h.split(":");
          if (kind === "k") desktop.inputKey({ key: Number(v), press: "up" });
          else desktop.inputMouse({ press: "up", button: v });
        }
        ws._held.clear();
      });
    }
    if (press === "down") ws._held.add(id); else ws._held.delete(id);
  }
  return {
    // ── Real desktop control (AnyDesk-style: watch + full input) ─────────
    async desktop_privacy(ws, msg) {
      if (!mayControl(ws) || !(videoWatchers.has(ws) || desktopWatchers.has(ws))) {
        return send(ws, { type: "desktop_privacy", ok: false, on: presence.privacyOn, error: "open the desktop with control first" });
      }
      const r = await presence.setPrivacy(msg.on === true);
      recorder.log(r.on ? "privacy_on" : "privacy_off", { device: deviceName(ws) });
      send(ws, { type: "desktop_privacy", ...r });
    },
    async desktop_start(ws, msg) {
      ws._viewOnly = !!msg.viewOnly || !!ws._viewOnlyForced;
      if (!(await approved(ws, !ws._viewOnly))) return send(ws, { type: "desktop_started", ok: false, reason: "denied on the PC" });
      // Binary frames need a real socket; relay shims fall back to JPEG.
      if (msg.video && typeof ws.bufferedAmount === "number") {
        videoWatchers.add(ws);
        ws._needKey = true;
        video.setPreset(msg.preset);
        if (msg.monitor != null) video.monitor = await monitorAt(Number(msg.monitor) || 0);
        const encoder = video.running ? await video.restart() : await video.start();
        if (encoder) {
          if (!ws._videoCloseHooked) {
            ws._videoCloseHooked = true;
            ws.once?.("close", () => { videoWatchers.delete(ws); if (!videoWatchers.size) video.stop(); syncCursor(); });
          }
          syncCursor();
          return send(ws, { type: "desktop_started", ok: true, mode: "h264", encoder, preset: video.preset, monitor: video.monitor?.index ?? 0, viewOnly: ws._viewOnly, recording: recorder.recordingScreen });
        }
        videoWatchers.delete(ws);
      }
      const r = await desktop.startFrameStream(ws._clientId || "anon", msg.quality);
      // A repeat start from the same socket must not stack another close listener.
      if (r.ok && !desktopWatchers.has(ws)) {
        desktopWatchers.add(ws);
        ws.once?.("close", () => {
          desktopWatchers.delete(ws);
          // A reconnect under the same clientId may already own the stream.
          if (![...desktopWatchers].some((w) => w._clientId === ws._clientId)) desktop.stopFrameStream(ws._clientId || "anon");
          syncCursor();
        });
      }
      syncCursor();
      send(ws, { type: "desktop_started", ...r, viewOnly: ws._viewOnly, recording: recorder.recordingScreen });
    },
    // Viewers align their clock with the daemon's to turn frame stamps into delays.
    async desktop_ping(ws, msg) {
      send(ws, { type: "desktop_pong", t: msg.t, server: Date.now() });
    },
    async desktop_monitors(ws, msg) {
      const r = await desktop.monitors();
      if (r.ok) monitorList = r.monitors;
      send(ws, { type: "desktop_monitors", ...r, current: video.monitor?.index ?? 0 });
    },
    // iroh viewers report GOP progress so the daemon sees delay hidden in QUIC and relay buffers.
    async video_ack(ws, msg) {
      ws.onVideoAck?.(Number(msg.g) || 0, Number(msg.f) || 0);
    },
    async desktop_stop(ws, msg) {
      if (videoWatchers.delete(ws) && !videoWatchers.size) video.stop();
      desktopWatchers.delete(ws);
      const r = desktop.stopFrameStream(ws._clientId || "anon");
      syncCursor();
      send(ws, { type: "desktop_stopped", ...r });
    },
    async desktop_frame(ws, msg) {
      // On-demand single frame (thumbnail / refresh) without starting the loop.
      if (!(await approved(ws, false))) return send(ws, { type: "desktop_frame_error", reason: "denied on the PC" });
      clearTimeout(snapshots.get(ws));
      snapshots.set(ws, setTimeout(() => { snapshots.delete(ws); syncCursor(); }, 5000));
      syncCursor();
      const r = await desktop.getFrame();
      send(ws, r.ok ? { type: "desktop_frame", ...r } : { type: "desktop_frame_error", reason: r.reason });
    },
    async desktop_mouse(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      // Frame px -> real desktop px: the capture helper downscales the full
      // virtual screen by the quality factor (1 / 0.75 / 0.5), so client
      // coords measured on the frame must be divided back out. Wheel-only
      // events carry no meaningful x/y and skip the transform.
      const factor = videoWatchers.has(ws) ? video.scale : desktop.scale;
      const origin = (videoWatchers.has(ws) && video.monitor) || { x: 0, y: 0 };
      const at = msg.x != null && msg.y != null && msg.wheel == null;
      const x = at ? Math.round(Number(msg.x) / factor) + origin.x : undefined;
      const y = at ? Math.round(Number(msg.y) / factor) + origin.y : undefined;
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      const button = ["left", "right", "middle"].includes(msg.button) ? msg.button : "left";
      if (press) hold(ws, "b:" + button, press);
      const r = await desktop.inputMouse({ x, y, click: msg.click, press, button, wheel: msg.wheel });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_key(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      if (press) hold(ws, "k:" + Number(msg.key), press);
      const r = await desktop.inputKey({ key: msg.key, press, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_type(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      const r = await desktop.inputType(String(msg.text ?? ""));
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async clipboard_get(ws, msg) {
      if (!ws._desktopApproved && presence.approvalRequired) return send(ws, { type: "clipboard", ok: false, error: "not approved on the PC" });
      send(ws, { type: "clipboard", ...(await desktop.clipboardRead()) });
    },
    /** text, png (base64) or files (paths on the PC, e.g. just uploaded); paste presses Ctrl+V after. */
    async clipboard_set(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "clipboard_set_ok", ok: false, error: "view only" });
      let files;
      try {
        files = Array.isArray(msg.files) ? msg.files.slice(0, 100).map((f) => resolvePath(f)) : undefined;
      } catch (e) {
        return send(ws, { type: "clipboard_set_ok", ok: false, error: e.message });
      }
      const text = msg.text == null ? undefined : String(msg.text).slice(0, 1 << 20);
      const png = typeof msg.png === "string" ? msg.png.slice(0, 24 << 20) : undefined;
      const r = await desktop.clipboardSet({ text, png, files });
      if (r.ok && files) recorder.log("files_sent", { device: deviceName(ws), files });
      if (r.ok && msg.paste) await desktop.inputKey({ key: 86, modifiers: ["ctrl"] });
      send(ws, { type: "clipboard_set_ok", ...r });
    },
    async desktop_quality(ws, msg) {
      send(ws, { type: "desktop_quality_ok", ...desktop.setQuality(Number(msg.quality) || 60) });
    },
    async desktop_status(ws, msg) {
      send(ws, { type: "desktop_status", ...desktop.getStatus() });
    },
  };
}
