import { resolvePath } from "../fs_ops.js";
import * as devices from "../devices.js";
import { centerFor, fromFraction } from "../desktop_capture.js";

export default function remoteHandlers(ctx) {
  const { send, desktop, desktopWatchers, video, videoWatchers, recorder, access, syncAudio } = ctx;
  // Sockets that took a single snapshot stay on the viewer set for a few seconds.
  const snapshots = new Map();
  const deviceName = (ws) => devices.list().find((d) => d.id === ws._clientId)?.name || "A remote device";
  const watching = (ws) => videoWatchers.has(ws) || desktopWatchers.has(ws);
  /** Codecs every current video viewer can decode, in the first viewer's order; H.264 is the floor. */
  function sharedCodecs() {
    const lists = [...videoWatchers].map((w) => w._codecs || []);
    if (!lists.length) return ["h264"];
    const shared = lists[0].filter((c) => lists.every((l) => l.includes(c)));
    return shared.includes("h264") ? shared : [...shared, "h264"];
  }
  /** Pointer and clipboard follow the PC only while someone is viewing it. */
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
  }
  let logged = new Set();
  /** Input and clipboard writes: never view-only, never when the PC owner has paused control,
   *  and never from a socket that is not currently watching (a stopped stream keeps no control). */
  function mayControl(ws) {
    return access.controlAllowed && !ws._viewOnly && watching(ws);
  }
  // The PC owner flipping "allow control" off drops every live controller to view-only at once.
  if (access) access.onControlChange = (on) => {
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
      if (!on) { w._viewOnly = true; release(w); }
      else if (!w._viewOnlyForced) w._viewOnly = false;
      send(w, { type: "control_allowed", allowed: on, viewOnly: !!w._viewOnly });
    }
  };
  async function monitorAt(index) {
    if (!desktop.monitorList?.[index]) await desktop.monitors();
    return desktop.monitorList?.[index] || null;
  }
  // A viewer that drops, stops or loses control mid-press would leave the key or button stuck down on the PC.
  function release(ws) {
    for (const h of ws._held || []) {
      const [kind, v] = h.split(":");
      if (kind === "k") desktop.inputKey({ key: Number(v), press: "up" });
      else desktop.inputMouse({ press: "up", button: v });
    }
    ws._held?.clear();
  }
  function hold(ws, id, press) {
    if (!ws._held) {
      ws._held = new Set();
      ws.once?.("close", () => release(ws));
    }
    if (press === "down") ws._held.add(id); else ws._held.delete(id);
  }
  const wheelAmount = (v) => (v == null ? undefined : Math.max(-12000, Math.min(12000, Math.round(Number(v)) || 0)));
  return {
    // ── Real desktop control (AnyDesk-style: watch + full input) ─────────
    async desktop_start(ws, msg) {
      ws._viewOnly = !!msg.viewOnly || !!ws._viewOnlyForced || !access.controlAllowed;
      // Codecs the phone can decode, best first (av1, hevc, h264); older clients send none and get H.264.
      ws._codecs = Array.isArray(msg.codecs) ? msg.codecs.filter((c) => ["av1", "hevc", "h264"].includes(c)) : [];
      ws._audio = !!msg.audio;
      // Binary frames need a real socket; relay shims fall back to JPEG.
      if (msg.video && typeof ws.bufferedAmount === "number") {
        videoWatchers.add(ws);
        ws._needKey = true;
        video.setPreset(msg.preset);
        // One encoder serves everyone, so only codecs every current viewer decodes are on the table.
        video.setCodecs(sharedCodecs());
        if (msg.monitor != null) video.monitor = await monitorAt(Number(msg.monitor) || 0);
        const encoder = video.running ? await video.restart() : await video.start();
        if (encoder) {
          if (!ws._videoCloseHooked) {
            ws._videoCloseHooked = true;
            ws.once?.("close", () => { videoWatchers.delete(ws); if (!videoWatchers.size) video.stop(); syncCursor(); syncAudio(); });
          }
          // A chosen screen starts with the pointer in its middle, so it is never left on a screen out of view.
          if (mayControl(ws) && video.monitor) {
            const to = centerFor(video.monitor, await desktop.pointer(), ws._monitor);
            if (to) await desktop.inputMouse(to);
          }
          ws._monitor = video.monitor?.index;
          syncCursor();
          syncAudio();
          return send(ws, { type: "desktop_started", ok: true, mode: "h264", encoder, codec: video.codec, audio: ws._audio, preset: video.preset, monitor: video.monitor?.index ?? 0, viewOnly: ws._viewOnly, recording: recorder.recordingScreen });
        }
        videoWatchers.delete(ws);
      }
      const r = await desktop.startFrameStream(ws._clientId || "anon", msg.quality);
      // Pointing by fraction needs to know what the still frames show.
      if (r.ok && !desktop.monitorList) await desktop.monitors();
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
      // No h264 here (relay, or a non-Windows host): the client renders the pushed JPEG frames.
      send(ws, { type: "desktop_started", mode: "jpeg", ...r, viewOnly: ws._viewOnly, recording: recorder.recordingScreen });
    },
    // Viewers align their clock with the daemon's to turn frame stamps into delays.
    async desktop_ping(ws, msg) {
      send(ws, { type: "desktop_pong", t: msg.t, server: Date.now() });
    },
    async desktop_monitors(ws, msg) {
      const r = await desktop.monitors();
      send(ws, { type: "desktop_monitors", ...r, current: video.monitor?.index ?? 0 });
    },
    // iroh viewers report GOP progress so the daemon sees delay hidden in QUIC and relay buffers.
    async video_ack(ws, msg) {
      ws.onVideoAck?.(Number(msg.g) || 0, Number(msg.f) || 0);
    },
    async desktop_stop(ws, msg) {
      release(ws);
      ws._audio = false;
      if (videoWatchers.delete(ws) && !videoWatchers.size) video.stop();
      desktopWatchers.delete(ws);
      const r = desktop.stopFrameStream(ws._clientId || "anon");
      syncAudio();
      syncCursor();
      send(ws, { type: "desktop_stopped", ...r });
    },
    async desktop_frame(ws, msg) {
      // On-demand single frame (thumbnail / refresh) without starting the loop.
      clearTimeout(snapshots.get(ws));
      snapshots.set(ws, setTimeout(() => { snapshots.delete(ws); syncCursor(); }, 5000));
      syncCursor();
      const r = await desktop.getFrame();
      send(ws, r.ok ? { type: "desktop_frame", ...r } : { type: "desktop_frame_error", reason: r.reason });
    },
    // Input replies only on failure: a busy pointer would otherwise echo every move over the relay.
    async desktop_mouse(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      // fx/fy, a fraction of the picture, maps straight onto the monitor it shows, whatever pixel
      // size the capture has (a Retina Mac captures twice its point size). Older viewers send
      // only picture px, divided back out by the quality factor. Wheel-only events skip both.
      const video_ = videoWatchers.has(ws);
      const rect = video_ ? video.monitor : desktop.frameRect;
      const wheel = wheelAmount(msg.wheel);
      const hwheel = wheelAmount(msg.hwheel);
      const fx = Number(msg.fx), fy = Number(msg.fy);
      const finite = (v) => v != null && Number.isFinite(Number(v));
      let x, y;
      if (wheel == null && hwheel == null) {
        if (rect && finite(msg.fx) && finite(msg.fy)) {
          ({ x, y } = fromFraction(rect, Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))));
        } else if (finite(msg.x) && finite(msg.y)) {
          const factor = video_ ? video.scale : desktop.scale;
          const origin = (video_ && video.monitor) || { x: 0, y: 0 };
          x = Math.round(Number(msg.x) / factor) + origin.x;
          y = Math.round(Number(msg.y) / factor) + origin.y;
        }
      }
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      const button = ["left", "right", "middle"].includes(msg.button) ? msg.button : "left";
      const click = ["left", "right", "middle", "double"].includes(msg.click) ? msg.click : undefined;
      if (press) hold(ws, "b:" + button, press);
      const r = await desktop.inputMouse({ x, y, click, press, button, wheel, hwheel });
      if (!r.ok) send(ws, { type: "desktop_input_ok", ok: false, error: r.error });
    },
    async desktop_key(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      if (press) hold(ws, "k:" + Number(msg.key), press);
      const r = await desktop.inputKey({ key: msg.key, press, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
      if (!r.ok) send(ws, { type: "desktop_input_ok", ok: false, error: r.error });
    },
    async desktop_type(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      const r = await desktop.inputType(String(msg.text ?? ""));
      if (!r.ok) send(ws, { type: "desktop_input_ok", ok: false, error: r.error });
    },
    async clipboard_get(ws, msg) {
      if (!watching(ws)) return send(ws, { type: "clipboard", ok: false, error: "open the desktop first" });
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
      if (r.ok && msg.paste) await desktop.inputKey({ key: 86, modifiers: [process.platform === "darwin" ? "win" : "ctrl"] });
      send(ws, { type: "clipboard_set_ok", ...r });
    },
    async desktop_quality(ws, msg) {
      send(ws, { type: "desktop_quality_ok", ...desktop.setQuality(Number(msg.quality) || 60) });
    },
    async desktop_status(ws, msg) {
      send(ws, { type: "desktop_status", ...desktop.getStatus() });
    },
    // macOS grants: { request:true } shows the system prompts on the PC, so only a controller may ask.
    async desktop_permissions(ws, msg) {
      const r = msg.request && mayControl(ws) ? await desktop.requestPermissions() : await desktop.permissions();
      send(ws, { type: "desktop_permissions", ...r });
    },
  };
}
