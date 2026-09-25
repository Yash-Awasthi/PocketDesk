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
  const { send, wa, rd, vnc, desktop, desktopWatchers, video, videoWatchers } = ctx;
  return {
    // ── WhatsApp bridge (whatsapp-claude-plugin: channel surface) ─────────
    async wa_create(ws, msg) {
      const ch = wa.createChannel(String(msg.sessionId ?? ""), { allowedNumbers: Array.isArray(msg.allowedNumbers) ? msg.allowedNumbers.map(String) : [], commandPrefix: msg.commandPrefix ? String(msg.commandPrefix) : undefined, transport: msg.transport });
      send(ws, { type: "wa_channel", channel: ch });
    },
    async wa_auth_start(ws, msg) {
      // A WhatsApp channel's QR arrives asynchronously on wa_event/qr; the
      // ack here only says the socket booted.
      try {
        const qr = await wa.startAuthentication(String(msg.channelId ?? ""));
        send(ws, { type: "wa_qr", ok: qr !== null, channelId: msg.channelId, qr: qr ?? undefined });
      } catch (e) {
        send(ws, { type: "wa_qr", ok: false, channelId: msg.channelId, error: e.message });
      }
    },
    async wa_auth_complete(ws, msg) {
      const ok = wa.completeAuthentication(String(msg.channelId ?? ""), String(msg.phoneNumber ?? ""));
      send(ws, { type: "wa_auth_ok", ok });
    },
    async wa_ready(ws, msg) {
      const ok = wa.markReady(String(msg.channelId ?? ""));
      send(ws, { type: "wa_ready_ok", ok });
    },
    async wa_incoming(ws, msg) {
      wa.handleMessage(String(msg.channelId ?? ""), { id: String(msg.messageId ?? ""), from: String(msg.from ?? ""), to: "", body: String(msg.body ?? ""), timestamp: new Date(), isGroup: false });
      send(ws, { type: "wa_incoming_ok", ok: true });
    },
    async wa_reply(ws, msg) {
      const ok = wa.sendReply(String(msg.channelId ?? ""), String(msg.to ?? ""), String(msg.body ?? ""));
      send(ws, { type: "wa_reply_ok", ok });
    },
    async wa_messages(ws, msg) {
      send(ws, { type: "wa_messages", items: wa.getMessages(String(msg.channelId ?? ""), Number(msg.limit) || 50) });
    },
    async wa_list(ws, msg) {
      send(ws, { type: "wa_list", items: wa.getChannels() });
    },
    async wa_stats(ws, msg) {
      send(ws, { type: "wa_stats", ...wa.getStats() });
    },
    async wa_disconnect(ws, msg) {
      const ok = wa.disconnect(String(msg.channelId ?? ""));
      send(ws, { type: "wa_disconnected", ok });
    },
    // ── Remote desktop bridge (rustdesk/remodex: sessions + input + transfers) ──
    async rd_create(ws, msg) {
      const s = await rd.createSession(String(msg.hostName ?? "pc"), String(msg.hostIp ?? "local"), msg.quality);  // eslint-disable-line no-use-before-define
      send(ws, { type: "rd_session", session: { ...s, connectedAt: s.connectedAt.toISOString(), lastActivity: s.lastActivity.toISOString() } });
    },
    async rd_frame(ws, msg) {
      const f = await rd.getFrame(String(msg.sessionId ?? ""));
      send(ws, f.ok ? { type: "rd_frame", sessionId: msg.sessionId, ...f } : { type: "rd_frame_error", sessionId: msg.sessionId, reason: f.reason });
    },
    async rd_input(ws, msg) {
      const r = await rd.sendInput(String(msg.sessionId ?? ""), { type: String(msg.inputType ?? "mouse_move"), x: msg.x, y: msg.y, button: msg.button, wheel: msg.wheel, key: msg.key, text: msg.text, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
      send(ws, { type: "rd_input_ok", ok: !!r.ok, reason: r.reason, error: r.error });
    },
    async rd_quality(ws, msg) {
      const ok = rd.updateQuality(String(msg.sessionId ?? ""), String(msg.quality ?? "medium"));
      send(ws, { type: "rd_quality_ok", ok });
    },
    async rd_disconnect(ws, msg) {
      const ok = rd.disconnect(String(msg.sessionId ?? ""));
      send(ws, { type: "rd_disconnected", ok });
    },
    async rd_list(ws, msg) {
      send(ws, { type: "rd_list", items: rd.getActiveSessions().map((s) => ({ ...s, connectedAt: s.connectedAt.toISOString(), lastActivity: s.lastActivity.toISOString() })) });
    },
    async rd_stats(ws, msg) {
      send(ws, { type: "rd_stats", ...rd.getStats() });
    },
    // ── VNC bridge (noVNC/guacamole: TCP frame server + frame feed) ──────
    async vnc_start(ws, msg) {
      const r = await vnc.start(Number(msg.port) || 0, { bindAll: Boolean(msg.bindAll) });
      send(ws, { type: "vnc_started", ...r });
    },
    async vnc_stop(ws, msg) {
      const r = await vnc.stop();
      send(ws, { type: "vnc_stopped", ...r });
    },
    async vnc_status(ws, msg) {
      send(ws, { type: "vnc_status", ...vnc.getStatus() });
    },
    async vnc_frame(ws, msg) {
      vnc.updateFrame(Buffer.from(String(msg.data ?? ""), "base64"), { width: Number(msg.width) || 0, height: Number(msg.height) || 0 });
      send(ws, { type: "vnc_frame_ok", ok: true });
    },
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
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
      // Frame px -> real desktop px: the capture helper downscales the full
      // virtual screen by the quality factor (1 / 0.75 / 0.5), so client
      // coords measured on the frame must be divided back out. Wheel-only
      // events carry no meaningful x/y and skip the transform.
      const factor = videoWatchers.has(ws) ? video.scale : desktop.scale;
      const at = msg.x != null && msg.y != null && msg.wheel == null;
      const x = at ? Math.round(Number(msg.x) / factor) : undefined;
      const y = at ? Math.round(Number(msg.y) / factor) : undefined;
      const r = await desktop.inputMouse({ x, y, click: msg.click, press: msg.press, wheel: msg.wheel });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_key(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
      const r = await desktop.inputKey({ key: msg.key, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async desktop_type(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
      const r = await desktop.inputType(String(msg.text ?? ""));
      send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
    },
    async clipboard_get(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
      try {
        const text = await ps("$t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }");
        send(ws, { type: "clipboard", ok: true, text });
      } catch (e) { send(ws, { type: "clipboard", ok: false, error: e.message }); }
    },
    async clipboard_set(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
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
