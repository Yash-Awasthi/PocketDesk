// SPDX-License-Identifier: GPL-3.0-or-later
// Any device drives any other through this PC: a desktop viewer (the phone app, the PC page, or
// another PC) names a source on desktop_start, and the same desktop messages then reach it.
//   local              this PC
//   adb:<serial>       a phone connected to this PC with adb
//   share              a phone sharing its screen through the PocketDesk app (it asks its owner)
//   pc:<id>[/<source>] a saved PC, or a source of its own (its phones, its saved PCs)
import os from "node:os";
import { bridge } from "./phone_adb.js";
import { computers } from "./computers.js";
import { shareFeed } from "./phone.js";

const ROUTED = ["desktop_start", "desktop_stop", "desktop_mouse", "desktop_key", "desktop_type", "desktop_ping",
  "desktop_monitors", "desktop_quality", "video_ack", "clipboard_get", "clipboard_set"];

/** Wraps the desktop handlers in [handlers] so they follow each viewer's chosen source. */
export function withSources(handlers, ctx) {
  const { send, access } = ctx;
  const local = Object.fromEntries(ROUTED.map((t) => [t, handlers[t]]));

  function stop(ws) {
    const s = ws._src;
    ws._src = null;
    if (!s) return;
    if (s.kind === "adb") bridge.closeFeed?.(s.v);
    else if (s.kind === "share") shareFeed.close(ws);
    else if (s.link.ws.readyState === 1) s.link.ws.send(JSON.stringify({ type: "desktop_stop" }));
  }

  async function start(ws, msg) {
    const source = String(msg.source || "local");
    stop(ws);
    if (source === "local") {
      return local.desktop_start(ws, msg);
    }
    if (ctx.videoWatchers?.has(ws) || ctx.desktopWatchers?.has(ws)) await local.desktop_stop(ws, {});
    if (source.startsWith("adb:")) {
      const v = await bridge.openFeed(ws, source.slice(4), msg);
      ws._src = { kind: "adb", v, source };
      return send(ws, { type: "desktop_started", ok: true, mode: "h264", codec: "h264", audio: false, preset: msg.preset, monitor: 0, viewOnly: false, recording: false, source, os: "android" });
    }
    if (source === "share") {
      if (!shareFeed.phones().length) throw new Error("no phone with the PocketDesk app is connected");
      ws._src = { kind: "share", source };
      await shareFeed.open(ws);
      return send(ws, { type: "desktop_started", ok: true, mode: "h264", codec: "h264", audio: false, preset: msg.preset, monitor: 0, viewOnly: false, recording: false, source, os: "android" });
    }
    const m = /^pc:([\w-]+)(?:\/(.+))?$/.exec(source);
    if (!m) throw new Error("unknown source");
    // Local daemon already handled it if this PC is the target, so a stale self-link is harmless.
    const open = computers.linkOf(ws, m[1], true);
    const l = open?.ws.readyState === 1 ? open : await computers.link(ws, m[1], { raw: true });
    ws._src = { kind: "pc", link: l, source };
    l.ws.send(JSON.stringify({ ...msg, source: m[2] || undefined }));
  }

  const routed = (type) => async (ws, msg) => {
    if (type === "desktop_start") {
      try { await start(ws, msg); } catch (e) { send(ws, { type: "desktop_started", ok: false, reason: e.message, source: msg.source }); }
      return;
    }
    const s = ws._src;
    if (!s) return local[type]?.(ws, msg);
    if (type === "desktop_stop") { stop(ws); return send(ws, { type: "desktop_stopped", ok: true, source: s.source }); }
    // Paused control on this PC, or a view-only device, keeps every source it reaches view-only too.
    if (/^(desktop_mouse|desktop_key|desktop_type|clipboard_set)$/.test(type) && (!access.controlAllowed || ws._viewOnlyForced)) {
      return send(ws, { type: "desktop_input_ok", ok: false, error: "view only" });
    }
    if (s.kind === "pc") {
      if (s.link.ws.readyState === 1) s.link.ws.send(JSON.stringify(msg));
      return;
    }
    if (s.kind === "share") {
      if (type === "desktop_ping") return send(ws, { type: "desktop_pong", t: msg.t, server: Date.now() });
      if (type === "desktop_monitors") return send(ws, { type: "desktop_monitors", ok: true, monitors: [{ index: 0, ...shareFeed.size(), primary: true }], current: 0 });
      if (type === "clipboard_set" && typeof msg.text === "string") return shareFeed.input(ws, "desktop_type", { text: msg.text });
      if (/^desktop_(mouse|key|type)$/.test(type)) shareFeed.input(ws, type, msg);
      return;
    }
    if (type === "desktop_ping") return send(ws, { type: "desktop_pong", t: msg.t, server: Date.now() });
    if (type === "desktop_monitors") return send(ws, { type: "desktop_monitors", ok: true, monitors: [{ index: 0, w: s.v.size?.width, h: s.v.size?.height, primary: true }], current: 0 });
    if (type === "clipboard_set" && typeof msg.text === "string") return bridge.feedInput?.(s.v, "desktop_type", { text: msg.text });
    if (type === "desktop_mouse" || type === "desktop_key" || type === "desktop_type") bridge.feedInput?.(s.v, type, msg);
  };

  for (const t of ROUTED) handlers[t] = routed(t);

  /** Everything this PC can show to a viewer: itself, its phones, its saved PCs and, asked, theirs. */
  handlers.sources_list = async (ws, msg) => {
    const of = /^pc:([\w-]+)$/.exec(String(msg.of || ""));
    if (of) {
      try {
        const l = computers.linkOf(ws, of[1], true) || await computers.link(ws, of[1], { raw: true });
        l.ws.send(JSON.stringify({ type: "sources_list" }));
      } catch (e) { send(ws, { type: "sources_list", of: msg.of, items: [], error: e.message }); }
      return;
    }
    const phones = await bridge.phones?.().catch(() => []) || [];
    send(ws, {
      type: "sources_list",
      items: [
        { id: "local", name: os.hostname(), os: process.platform, kind: "pc" },
        ...shareFeed.phones().filter((w) => w !== ws).slice(-1).map((w) => ({ id: "share", name: w._name || "Phone", os: "android", kind: "phone", via: "app" })),
        ...phones.map((d) => ({ id: `adb:${d.serial}`, name: d.model || d.serial, os: "android", kind: "phone", via: d.wireless ? "wifi" : "usb" })),
        ...computers.list().map((c) => ({ id: `pc:${c.id}`, name: c.name, os: c.os || null, kind: "pc", online: computers.online.has(c.id), nested: true })),
      ],
    });
  };
  return handlers;
}
