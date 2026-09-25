import { execFile } from "node:child_process";

/** Runs a PowerShell snippet with UTF-8 both ways; stdin feeds [Console]::In. */
function ps(script, input = "") {
  return new Promise((resolve, reject) => {
    const utf8 = "[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
    const p = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", utf8 + script],
      { windowsHide: true, timeout: 10000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
    p.stdin.end(input, "utf8");
  });
}

export default function remoteHandlers(ctx) {
  const { send, desktop, desktopWatchers, video, videoWatchers } = ctx;
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
    async desktop_start(ws, msg) {
      // Binary frames need a real socket; relay shims fall back to JPEG.
      if (msg.video && typeof ws.bufferedAmount === "number") {
        videoWatchers.add(ws);
        ws._needKey = true;
        video.setPreset(msg.preset);
        const encoder = video.running ? await video.restart() : await video.start();
        if (encoder) {
          if (!ws._videoCloseHooked) {
            ws._videoCloseHooked = true;
            ws.once?.("close", () => { videoWatchers.delete(ws); if (!videoWatchers.size) video.stop(); });
          }
          return send(ws, { type: "desktop_started", ok: true, mode: "h264", encoder, preset: video.preset });
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
        });
      }
      send(ws, { type: "desktop_started", ...r });
    },
    // iroh viewers report GOP progress so the daemon sees delay hidden in QUIC and relay buffers.
    async video_ack(ws, msg) {
      ws.onVideoAck?.(Number(msg.g) || 0, Number(msg.f) || 0);
    },
    async desktop_stop(ws, msg) {
      if (videoWatchers.delete(ws) && !videoWatchers.size) video.stop();
      desktopWatchers.delete(ws);
      const r = desktop.stopFrameStream(ws._clientId || "anon");
      send(ws, { type: "desktop_stopped", ...r });
    },
    async desktop_frame(ws, msg) {
      // On-demand single frame (thumbnail / refresh) without starting the loop.
      const r = await desktop.getFrame();
      send(ws, r.ok ? { type: "desktop_frame", ...r } : { type: "desktop_frame_error", reason: r.reason });
    },
    async desktop_mouse(ws, msg) {
      // Frame px -> real desktop px: the capture helper downscales the full
      // virtual screen by the quality factor (1 / 0.75 / 0.5), so client
      // coords measured on the frame must be divided back out. Wheel-only
      // events carry no meaningful x/y and skip the transform.
      const factor = videoWatchers.has(ws) ? video.scale : desktop.scale;
      const at = msg.x != null && msg.y != null && msg.wheel == null;
      const x = at ? Math.round(Number(msg.x) / factor) : undefined;
      const y = at ? Math.round(Number(msg.y) / factor) : undefined;
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      const button = ["left", "right", "middle"].includes(msg.button) ? msg.button : "left";
      if (press) hold(ws, "b:" + button, press);
      const r = await desktop.inputMouse({ x, y, click: msg.click, press, button, wheel: msg.wheel });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_key(ws, msg) {
      const press = msg.press === "down" || msg.press === "up" ? msg.press : undefined;
      if (press) hold(ws, "k:" + Number(msg.key), press);
      const r = await desktop.inputKey({ key: msg.key, press, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_type(ws, msg) {
      const r = await desktop.inputType(String(msg.text ?? ""));
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async clipboard_get(ws, msg) {
      try {
        const text = await ps("$t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }");
        send(ws, { type: "clipboard", ok: true, text });
      } catch (e) { send(ws, { type: "clipboard", ok: false, error: e.message }); }
    },
    async clipboard_set(ws, msg) {
      try {
        await ps("Set-Clipboard -Value ([Console]::In.ReadToEnd())", String(msg.text ?? "").slice(0, 1 << 20));
        send(ws, { type: "clipboard_set_ok", ok: true });
      } catch (e) { send(ws, { type: "clipboard_set_ok", ok: false, error: e.message }); }
    },
    async desktop_quality(ws, msg) {
      send(ws, { type: "desktop_quality_ok", ...desktop.setQuality(Number(msg.quality) || 60) });
    },
    async desktop_status(ws, msg) {
      send(ws, { type: "desktop_status", ...desktop.getStatus() });
    },
  };
}
