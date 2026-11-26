import { resolvePath } from "../fs_ops.js";
import * as devices from "../devices.js";
import { centerFor, fromFraction } from "../desktop_capture.js";
import { PcMedia } from "../pc_media.js";
import { keyOf, label, loadPrefs, savePrefs } from "../monitor_names.js";
import { spawn } from "node:child_process";
import { streamCapKbps } from "../config.js";

const pcMedia = new PcMedia();

export default function remoteHandlers(ctx) {
  const {
    send,
    desktop,
    clippy,
    desktopWatchers,
    video,
    videoWatchers,
    recorder,
    access,
    syncAudio,
    audioListeners,
    monitorRefresh,
  } = ctx;
  // Sockets that took a single snapshot stay on the viewer set for a few seconds.
  const snapshots = new Map();
  const deviceName = (ws) => devices.list().find((d) => d.id === ws._clientId)?.name || "A remote device";
  const watching = (ws) => videoWatchers.has(ws) || desktopWatchers.has(ws);
  /** One encoder serves every viewer, so the smallest non-zero request wins. */
  function applyCap() {
    const caps = [streamCapKbps(), ...[...videoWatchers].map((w) => w._capKbps)].filter(
      (n) => Number.isFinite(n) && n > 0,
    );
    return video.setCap(caps.length ? Math.min(...caps) : 0);
  }
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
    desktop.watchProtected(on);
    desktop.setCaptureAllowed(on);
    if (on && desktop.cursor) desktop.emit("cursor", desktop.cursor);
    const viewers = new Set([...videoWatchers, ...desktopWatchers, ...snapshots.keys()]);
    for (const w of viewers)
      if (!logged.has(w))
        recorder.log("viewer_joined", {
          device: deviceName(w),
          viewOnly: !!w._viewOnly,
          snapshot: snapshots.has(w) && !videoWatchers.has(w) && !desktopWatchers.has(w),
        });
    for (const w of logged) if (!viewers.has(w)) recorder.log("viewer_left", { device: deviceName(w) });
    logged = viewers;
    recorder.screenWatched(on, {
      label: viewers.size ? deviceName([...viewers][0]) : "",
      monitor: video.monitor,
    });
  }
  let logged = new Set();
  /** Input and clipboard writes: never view-only, never when the PC owner has paused control,
   *  and never from a socket that is not currently watching (a stopped stream keeps no control). */
  function mayControl(ws) {
    return access.controlAllowed && !ws._viewOnly && watching(ws);
  }
  // The PC owner flipping "allow control" off drops every live controller to view-only at once.
  if (access)
    access.onControlChange = (on) => {
      for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
        if (!on) {
          w._viewOnly = true;
          release(w);
        } else if (!w._viewOnlyForced) w._viewOnly = false;
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
    if (press === "down") ws._held.add(id);
    else ws._held.delete(id);
  }
  const wheelAmount = (v) =>
    v == null ? undefined : Math.max(-12000, Math.min(12000, Math.round(Number(v)) || 0));
  return {
    // ── Real desktop control (AnyDesk-style: watch + full input) ─────────
    async desktop_start(ws, msg) {
      ws._viewOnly = !!msg.viewOnly || !!ws._viewOnlyForced || !access.controlAllowed;
      // Codecs the phone can decode, best first (av1, hevc, h264); older clients send none and get H.264.
      ws._codecs = Array.isArray(msg.codecs)
        ? msg.codecs.filter((c) => ["av1", "hevc", "h264"].includes(c))
        : [];
      ws._audio = !!msg.audio;
      // Audio-only for a poor link: no encoder and no still frames, just the PC's sound.
      if (msg.audioOnly === true || msg.mode === "audio") {
        ws._audio = true;
        if (videoWatchers.delete(ws)) {
          applyCap();
          if (!videoWatchers.size) video.stop();
        }
        desktopWatchers.delete(ws);
        desktop.stopFrameStream(ws._clientId || "anon");
        audioListeners.add(ws);
        if (!ws._audioHooked) {
          ws._audioHooked = true;
          ws.once?.("close", () => {
            audioListeners.delete(ws);
            syncAudio();
          });
        }
        syncAudio();
        syncCursor();
        return send(ws, {
          type: "desktop_started",
          ok: true,
          mode: "audio",
          audio: true,
          maxKbps: 0,
          viewOnly: ws._viewOnly,
          recording: recorder.recordingScreen,
        });
      }
      // A viewer may ask for less than the machine's ceiling; 0 means "whatever the preset does".
      const asked = Number(msg.stream?.maxKbps);
      ws._capKbps = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 50_000) : 0;
      // A screen plugged in or unplugged while this viewer watches must reach it without a reconnect.
      monitorRefresh?.();
      // Binary frames need a real socket; relay shims fall back to JPEG.
      if (msg.video && typeof ws.bufferedAmount === "number") {
        videoWatchers.add(ws);
        ws._needKey = true;
        video.setPreset(msg.preset);
        // One encoder serves everyone, so only codecs every current viewer decodes are on the table.
        video.setCodecs(sharedCodecs());
        // follow: mirror whichever monitor holds the foreground window (game on a second screen).
        if (msg.follow) {
          if (!desktop.monitorList) await desktop.monitors();
          const fm = await desktop.foregroundMonitor();
          if (fm) video.monitor = fm;
        } else if (msg.monitor != null) video.monitor = await monitorAt(Number(msg.monitor) || 0);
        else if (!video.monitor) {
          // Nobody picked a screen: show the desktop as it is, both screens of an extended setup whole.
          const list = desktop.monitorList || (await desktop.monitors()).monitors || [];
          video.monitor = list.find((m) => m.all) || null;
        }
        applyCap();
        const encoder = video.running ? await video.restart() : await video.start();
        if (encoder) {
          if (!ws._videoCloseHooked) {
            ws._videoCloseHooked = true;
            ws.once?.("close", () => {
              videoWatchers.delete(ws);
              applyCap();
              if (!videoWatchers.size) video.stop();
              syncCursor();
              syncAudio();
            });
          }
          // A chosen screen starts with the pointer in its middle, so it is never left on a screen out of view.
          if (mayControl(ws) && video.monitor) {
            const to = centerFor(video.monitor, await desktop.pointer(), ws._monitor);
            if (to) await desktop.inputMouse(to);
          }
          ws._monitor = video.monitor?.index;
          syncCursor();
          syncAudio();
          return send(ws, {
            type: "desktop_started",
            ok: true,
            mode: "h264",
            encoder,
            codec: video.codec,
            audio: ws._audio,
            preset: video.preset,
            maxKbps: video.capKbps,
            monitor: video.monitor?.index ?? 0,
            viewOnly: ws._viewOnly,
            recording: recorder.recordingScreen,
          });
        }
        videoWatchers.delete(ws);
      }
      // Still frames are ~250 KB each at full size, and this is the path a slow link or a host
      // without H.264 falls back to, so it starts at half size; the viewer can raise it later.
      const stillQuality = Math.min(Number(msg.quality) || 35, 45);
      const r = await desktop.startFrameStream(ws._clientId || "anon", stillQuality);
      // Pointing by fraction needs to know what the still frames show.
      if (r.ok && !desktop.monitorList) await desktop.monitors();
      // A repeat start from the same socket must not stack another close listener.
      if (r.ok && !desktopWatchers.has(ws)) {
        desktopWatchers.add(ws);
        ws.once?.("close", () => {
          desktopWatchers.delete(ws);
          // A reconnect under the same clientId may already own the stream.
          if (![...desktopWatchers].some((w) => w._clientId === ws._clientId))
            desktop.stopFrameStream(ws._clientId || "anon");
          syncCursor();
        });
      }
      syncCursor();
      // No H.264 here (relay, or a host without an encoder): the client renders the pushed JPEG
      // frames. When not even the first one arrived, say why instead of showing a black window.
      send(ws, {
        type: "desktop_started",
        mode: "jpeg",
        ...r,
        viewOnly: ws._viewOnly,
        recording: recorder.recordingScreen,
      });
    },
    // Viewers align their clock with the daemon's to turn frame stamps into delays.
    async desktop_ping(ws, msg) {
      send(ws, { type: "desktop_pong", t: msg.t, server: Date.now() });
    },
    // Phone replies to keepalive pings; recorded so the link is known alive.
    async desktop_pong(_ws, _msg) {
      // Nothing to act on: the pong confirms the iroh/ws path is round-tripping.
    },
    async desktop_monitors(ws, _msg) {
      const r = await desktop.monitors();
      if (!r.ok) return send(ws, { type: "desktop_monitors", ...r, current: video.monitor?.index ?? 0 });
      send(ws, {
        type: "desktop_monitors",
        ok: true,
        ...label(r.monitors, loadPrefs()),
        current: video.monitor?.index ?? 0,
      });
    },
    /** Name one screen; the capture order behind the indices never changes. */
    async desktop_monitor_rename(ws, msg) {
      if (!access.controlAllowed)
        return send(ws, {
          type: "desktop_monitor_rename",
          ok: false,
          error: "control is paused on the PC",
        });
      const r = await desktop.monitors();
      const monitors = r.ok ? r.monitors : [];
      const m = Number.isInteger(msg.index) ? monitors.find((x) => x.index === msg.index) : undefined;
      if (!m) return send(ws, { type: "desktop_monitor_rename", ok: false, error: "no such monitor" });
      const prefs = loadPrefs();
      const key = keyOf(m);
      const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 40) : "";
      // An empty name clears the label, back to the name the hardware reports.
      if (name) prefs.names[key] = name;
      else delete prefs.names[key];
      savePrefs(prefs);
      send(ws, { type: "desktop_monitor_rename", ok: true, index: msg.index });
      // Every open hub window draws the list from this one message, so a rename re-sends all of it.
      send(ws, {
        type: "desktop_monitors",
        ok: true,
        ...label(monitors, prefs),
        current: video.monitor?.index ?? 0,
      });
    },
    /** Reorder the screens as the hub draws them; capture indices and streams stay as they are. */
    async desktop_monitor_order(ws, msg) {
      if (!access.controlAllowed)
        return send(ws, {
          type: "desktop_monitor_order",
          ok: false,
          error: "control is paused on the PC",
        });
      const r = await desktop.monitors();
      const monitors = r.ok ? r.monitors : [];
      const indices = monitors.map((m) => m.index);
      const want = msg.order;
      const good =
        Array.isArray(want) &&
        want.length === indices.length &&
        want.every((i) => Number.isInteger(i)) &&
        new Set(want).size === want.length &&
        indices.every((i) => want.includes(i));
      if (!good) return send(ws, { type: "desktop_monitor_order", ok: false, error: "bad order" });
      const prefs = loadPrefs();
      const byIndex = new Map(monitors.map((m) => [m.index, m]));
      // Indices are saved as their stable adapter/output keys so a replug keeps the order.
      prefs.order = want.map((i) => keyOf(byIndex.get(i)));
      savePrefs(prefs);
      send(ws, { type: "desktop_monitor_order", ok: true });
      send(ws, {
        type: "desktop_monitors",
        ok: true,
        ...label(monitors, prefs),
        current: video.monitor?.index ?? 0,
      });
    },
    // iroh viewers report GOP progress so the daemon sees delay hidden in QUIC and relay buffers.
    async video_ack(ws, msg) {
      ws.onVideoAck?.(Number(msg.g) || 0, Number(msg.f) || 0);
    },
    async desktop_stop(ws, _msg) {
      release(ws);
      ws._audio = false;
      if (audioListeners.delete(ws)) syncAudio();
      if (videoWatchers.delete(ws)) applyCap();
      if (!videoWatchers.size) video.stop();
      desktopWatchers.delete(ws);
      const r = desktop.stopFrameStream(ws._clientId || "anon");
      syncAudio();
      syncCursor();
      send(ws, { type: "desktop_stopped", ...r });
    },
    async desktop_frame(ws, _msg) {
      // On-demand single frame (thumbnail / refresh) without starting the loop.
      clearTimeout(snapshots.get(ws));
      snapshots.set(
        ws,
        setTimeout(() => {
          snapshots.delete(ws);
          syncCursor();
        }, 5000),
      );
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
      const fx = Number(msg.fx),
        fy = Number(msg.fy);
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
      const r = await desktop.inputKey({
        key: msg.key,
        press,
        modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [],
      });
      if (!r.ok) send(ws, { type: "desktop_input_ok", ok: false, error: r.error });
    },
    /** The phone as a speaker: this PC's sound alone, without the screen. */
    async pc_audio(ws, msg) {
      if (process.platform === "darwin")
        return send(ws, {
          type: "pc_audio",
          ok: false,
          error: "on a Mac the sound comes with the screen: open the desktop",
        });
      if (msg.on) {
        audioListeners.add(ws);
        if (!ws._audioHooked) {
          ws._audioHooked = true;
          ws.once?.("close", () => {
            audioListeners.delete(ws);
            syncAudio();
          });
        }
      } else audioListeners.delete(ws);
      syncAudio();
      send(ws, { type: "pc_audio", ok: true, on: audioListeners.has(ws) });
    },
    /** Handoff from the phone: a link opens in this PC's browser, other text lands on its clipboard. */
    async handoff(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "handoff", ok: false, error: "control is paused on the PC" });
      const text = String(msg.text ?? "")
        .trim()
        .slice(0, 200_000);
      if (!text) return send(ws, { type: "handoff", ok: false, error: "nothing to send" });
      if (!msg.copy && /^https?:\/\/\S+$/i.test(text)) {
        const [cmd, args] =
          process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", text]]
            : process.platform === "darwin"
              ? ["open", [text]]
              : ["xdg-open", [text]];
        spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true })
          .on("error", () => {})
          .unref();
        return send(ws, { type: "handoff", ok: true, opened: true });
      }
      const r = await desktop.clipboardSet({ text });
      send(ws, { type: "handoff", ok: r.ok, error: r.error, copied: true });
    },
    /** What this PC plays, pushed to the asking phone while its Deck is open. */
    async pc_media_watch(ws, msg) {
      const on = !!msg.on;
      if (on === !!ws._pcMedia) return;
      ws._pcMedia = on;
      if (on) {
        ws._pcMediaFn = (m) => send(ws, { type: "pc_media", ...m });
        pcMedia.on("change", ws._pcMediaFn);
        if (pcMedia.last)
          try {
            send(ws, { type: "pc_media", ...JSON.parse(pcMedia.last) });
          } catch {}
        ws.once?.("close", () => {
          if (ws._pcMedia) {
            ws._pcMedia = false;
            pcMedia.off("change", ws._pcMediaFn);
            pcMedia.watch(false);
          }
        });
      } else pcMedia.off("change", ws._pcMediaFn);
      pcMedia.watch(on);
    },
    /** The phone's Deck: one shortcut or media key, without the desktop open. Paused control still refuses. */
    async deck_key(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "deck_result", ok: false, error: "control is paused on the PC" });
      const r = await desktop.inputKey({
        key: msg.key,
        modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [],
      });
      send(ws, { type: "deck_result", ok: r.ok, error: r.error });
    },
    /** The phone's Remote (touchpad, air mouse, presenter, voice typing) without the desktop open. */
    async remote_input(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "remote_result", ok: false, error: "control is paused on the PC" });
      const button = ["left", "right", "middle"].includes(msg.button) ? msg.button : "left";
      let r;
      if (msg.kind === "move") {
        const lim = (v) => Math.max(-2000, Math.min(2000, Number(v) || 0));
        r = await desktop.inputMove(lim(msg.dx), lim(msg.dy));
      } else if (msg.kind === "click") {
        r = await desktop.inputMouse({ click: msg.button === "double" ? "double" : button });
      } else if (msg.kind === "press" && (msg.press === "down" || msg.press === "up")) {
        hold(ws, "b:" + button, msg.press);
        r = await desktop.inputMouse({ press: msg.press, button });
      } else if (msg.kind === "wheel") {
        r = await desktop.inputMouse({ wheel: wheelAmount(msg.wheel), hwheel: wheelAmount(msg.hwheel) });
      } else if (msg.kind === "text" && msg.text) {
        r = await desktop.inputType(String(msg.text).slice(0, 2000));
      } else return send(ws, { type: "remote_result", ok: false, error: "unknown input" });
      if (!r.ok) send(ws, { type: "remote_result", ok: false, error: r.error });
    },
    async desktop_type(ws, msg) {
      if (!mayControl(ws)) return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
      const r = await desktop.inputType(String(msg.text ?? ""));
      if (!r.ok) send(ws, { type: "desktop_input_ok", ok: false, error: r.error });
    },
    async clipboard_get(ws, _msg) {
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
      if (r.ok && msg.paste)
        await desktop.inputKey({ key: 86, modifiers: [process.platform === "darwin" ? "win" : "ctrl"] });
      send(ws, { type: "clipboard_set_ok", ...r });
    },
    async desktop_quality(ws, msg) {
      send(ws, { type: "desktop_quality_ok", ...desktop.setQuality(Number(msg.quality) || 60) });
    },
    async desktop_status(ws, _msg) {
      send(ws, { type: "desktop_status", ...desktop.getStatus() });
    },
    // clippy: keystroke recorder that captures Ctrl+C (foreground window + system clipboard)
    // into clippy_capture.json; PocketDesk pushes that text to the system clipboard so
    // Ctrl+V outside a game pastes what Ctrl+C copied inside it.
    async clippy_start(ws, _msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "clippy_start_ok", ok: false, error: "control is paused on the PC" });
      send(ws, { type: "clippy_start_ok", ...(await clippy.start()) });
    },
    async clippy_stop(ws, _msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "clippy_stop_ok", ok: false, error: "control is paused on the PC" });
      send(ws, { type: "clippy_stop_ok", ...(await clippy.stop()) });
    },
    async clippy_status(ws, _msg) {
      send(ws, { type: "clippy_status", ...(await clippy.status()) });
    },
    /** Choose where clippy stores capture + history. Empty dir resets to the exe folder. */
    async clippy_setdir(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "clippy_setdir_ok", ok: false, error: "control is paused on the PC" });
      send(ws, { type: "clippy_setdir_ok", ...(await clippy.setDir(msg.dir)) });
    },
    /** One-time elevated install of the Clippy scheduled task (UAC prompt). After this,
     *  clippy_start runs it with full administrator privileges. */
    async clippy_install(ws, _msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "clippy_install_ok", ok: false, error: "control is paused on the PC" });
      send(ws, { type: "clippy_install_ok", ...(await clippy.install()) });
    },
    /** Latest Ctrl+C capture, on demand. */
    async clippy_latest(ws, _msg) {
      send(ws, { type: "clippy_latest", ...(await clippy.latest()) });
    },
    /** Push the most recent clippy capture onto the PC's system clipboard,
     *  and optionally press Ctrl+V so the active window pastes it at once. */
    async clippy_paste(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced)
        return send(ws, { type: "clippy_paste_ok", ok: false, error: "control is paused on the PC" });
      const c = await clippy.latest(msg.at);
      if (!c.ok) return send(ws, { type: "clippy_paste_ok", ok: false, error: c.error });
      const body = c.typed || c.text;
      if (!body) return send(ws, { type: "clippy_paste_ok", ok: false, error: "capture is empty" });
      const r = await desktop.clipboardSet({ text: body });
      if (r.ok && msg.paste) {
        await desktop.inputKey({ key: 86, modifiers: [process.platform === "darwin" ? "win" : "ctrl"] });
      }
      send(ws, {
        type: "clippy_paste_ok",
        ok: r.ok,
        error: r.error,
        window: c.window,
        text: c.text,
        typed: c.typed,
        at: c.at,
      });
    },
    // macOS grants: { request:true } shows the system prompts on the PC, so only a controller may ask.
    async desktop_permissions(ws, msg) {
      const r =
        msg.request && mayControl(ws) ? await desktop.requestPermissions() : await desktop.permissions();
      send(ws, { type: "desktop_permissions", ...r });
    },
  };
}
