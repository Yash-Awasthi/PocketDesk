// SPDX-License-Identifier: GPL-3.0-or-later
// The phone on this PC over adb: its screen, apps and cameras each in a window of their own on the
// page (or popped out into an always-on-top Picture-in-Picture window), decoded with WebCodecs.
// Mouse, touchpad and keyboard become the phone's touches, scrolls and keys:
//   click / drag = a finger · hover = the mouse · right click = Back · middle click = Home
//   wheel = scroll · Ctrl+wheel or pinch = two fingers · keys = keys · Ctrl+V pastes this PC's clipboard
// Input mapping follows TwinDesk's phone window (GPL-3.0).
"use strict";

(() => {
const PD = (window.PD ||= {});
const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7, HOVER_EXIT: 10 };
const FINGER = -2;
const BIN_VIDEO = 0x40, BIN_AUDIO = 0x41, HEAD = 11;

PD.adb = { state: null, views: new Map(), apps: [], settings: loadSettings() };

function loadSettings() {
  const d = { codec: "h264", mbps: 8, fps: 60, maxSize: 0, audio: true, enterSends: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem("pd_phone") || "{}") }; } catch { return d; }
}
PD.adb.saveSettings = () => { try { localStorage.setItem("pd_phone", JSON.stringify(PD.adb.settings)); } catch {} };

const ICONS = {
  back: '<path d="M12.5 4.5 7 10l5.5 5.5"/>',
  home: '<circle cx="10" cy="10" r="5.5"/>',
  recents: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>',
  notifications: '<path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0"/>',
  settings: '<path d="M4 6h12 M4 10h12 M4 14h12"/><circle cx="7.5" cy="6" r="1.6"/><circle cx="12.5" cy="10" r="1.6"/><circle cx="8.5" cy="14" r="1.6"/>',
  rotate: '<path d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9 M4.5 3.5v3h3"/>',
  volumeUp: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M14 7.5v5 M11.5 10h5"/>',
  volumeDown: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M11.5 10h5"/>',
  power: '<path d="M10 3.5v6 M6.2 6a5.5 5.5 0 1 0 7.6 0"/>',
  screenOff: '<rect x="6" y="3" width="8" height="14" rx="1.5"/><path d="M3.5 3.5l13 13"/>',
  shot: '<path d="M3.5 6.5h3l1.5-2h4l1.5 2h3v9h-13z"/><circle cx="10" cy="11" r="2.8"/>',
  record: '<circle cx="10" cy="10" r="5"/>',
  pip: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><rect x="10" y="10" width="5.5" height="4.5" rx=".8"/>',
  full: '<path d="M4 8V4h4 M12 4h4v4 M16 12v4h-4 M8 16H4v-4"/>',
  close: '<path d="M5.5 5.5l9 9 M14.5 5.5l-9 9"/>',
  torch: '<path d="M7 3.5h6v3.5l-2 3v6.5H9v-6.5l-2-3z M7 7h6"/>',
  zoomIn: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l3.5 3.5 M9 6.5v5 M6.5 9h5"/>',
  zoomOut: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l3.5 3.5 M6.5 9h5"/>',
  sound: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M12.5 7a4 4 0 0 1 0 6 M14.5 5a7 7 0 0 1 0 10"/>',
};
PD.icon = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[k] || ""}</svg>`;

// ── state from the daemon ──
PD.on("adb_state", (m) => { PD.adb.state = m; PD.emit("adb_changed"); });
PD.on("adb_apps", (m) => { PD.adb.apps = m.apps || []; PD.emit("adb_apps_changed"); });
PD.on("adb_view", (m) => {
  let v = PD.adb.views.get(m.id);
  if (!v) v = makeView(m);
  Object.assign(v.info, m);
  v.title.textContent = m.label || m.kind;
  if (m.w && m.h) fit(v);
});
PD.on("adb_view_closed", (m) => {
  const v = PD.adb.views.get(m.id);
  if (!v) return;
  if (m.why && m.why !== "stopped") PD.toast(`${v.info.label}: ${m.why}`);
  destroy(v);
});
PD.on("adb_view_opts", (m) => { const v = PD.adb.views.get(m.id); if (v) v.el.classList.toggle("screen-off", !!m.screenOff); });
PD.on("adb_audio", (m) => { const v = PD.adb.views.get(m.id); if (v) v.audioCodec = m.codec; });
PD.on("adb_clipboard", async (m) => {
  if (!m.text || m.text === PD.adb.lastClip) return;
  PD.adb.lastClip = m.text;
  try { await navigator.clipboard.writeText(m.text); PD.toast("Copied from the phone"); } catch { PD.adb.pendingClip = m.text; }
  PD.emit("phone_clip", m.text);
});
PD.on("adb_error", (m) => PD.toast(`${m.op}: ${m.message}`, true));
PD.on("adb_screenshot", (m) => saveBlob(b64Blob(m.png, "image/png"), `phone-${stamp()}.png`, true));

PD.onBinary((b) => {
  if (b[0] !== BIN_VIDEO && b[0] !== BIN_AUDIO) return false;
  const v = PD.adb.views.get(b[1]);
  if (!v) return true;
  const flags = b[2], pts = new DataView(b.buffer, b.byteOffset + 3, 8).getFloat64(0), data = b.subarray(HEAD);
  if (b[0] === BIN_VIDEO) video(v, flags, pts, data);
  else audio(v, flags, pts, data);
  return true;
});

PD.adb.open = (kind, extra = {}) => {
  const s = PD.adb.settings;
  const o = { type: "adb_open", kind, codec: s.codec, mbps: s.mbps, fps: s.fps, maxSize: s.maxSize, audio: s.audio, ...extra };
  if (kind === "app" && extra.pkg) {
    // The last few apps opened in windows, for one-click reopening from Home.
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem("pd_recent_apps") || "[]"); } catch {}
    recent = [{ pkg: extra.pkg, label: extra.label || extra.pkg }, ...recent.filter((a) => a.pkg !== extra.pkg)].slice(0, 8);
    try { localStorage.setItem("pd_recent_apps", JSON.stringify(recent)); } catch {}
    PD.emit("adb_changed");
  }
  if (kind === "app") {
    const scale = Math.max(2, devicePixelRatio);
    o.w = Math.round(412 * scale); o.h = Math.round(860 * scale); o.dpi = Math.round(160 * scale);
  }
  PD.send(o);
};

// ── windows ──
function makeView(info) {
  const el = document.createElement("div");
  el.className = `pwin k-${info.kind}`;
  el.tabIndex = -1;
  const bar = document.createElement("div");
  bar.className = "pwin-bar";
  const title = document.createElement("span");
  title.className = "pwin-title";
  const tools = document.createElement("span");
  tools.className = "pwin-tools";
  bar.append(title, tools);
  const stage = document.createElement("div");
  stage.className = "pwin-stage";
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  stage.append(canvas);
  const status = document.createElement("div");
  status.className = "pwin-status";
  status.textContent = "Starting on the phone…";
  stage.append(status);
  const nav = document.createElement("div");
  nav.className = "pwin-nav";
  el.append(bar, stage, nav);
  const v = { id: info.id, info, el, bar, title, stage, canvas, status, ctx: canvas.getContext("2d", { alpha: false, desynchronized: true }), decoder: null, config: null, waitingKey: true, askedKey: 0, keysDown: new Set() };
  PD.adb.views.set(info.id, v);

  const btn = (k, title, fn, box = tools) => {
    const b = document.createElement("button");
    b.className = "ic";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = PD.icon(k);
    b.onclick = (e) => { e.stopPropagation(); fn(b); canvas.focus(); };
    box.append(b);
    return b;
  };
  const navKey = (key) => PD.send({ type: "adb_input", id: v.id, t: "nav", key });
  // Sound only (the phone's playback or its microphone): a small bar to record or stop.
  if (info.kind === "sound" || info.kind === "mic") {
    el.classList.add("audio-only");
    status.textContent = info.kind === "mic" ? "Listening to the phone's microphone…" : "Playing the phone's sound…";
    v.recBtn = btn("record", "Record to a file", () => record(v));
    btn("close", "Close", () => PD.send({ type: "adb_close", id: v.id }));
    title.textContent = info.kind === "mic" ? "Phone microphone" : "Phone sound";
    place(v);
    drag(v);
    el.addEventListener("pointerdown", () => front(v), true);
    PD.emit("adb_views_changed");
    return v;
  }
  if (info.kind === "camera") {
    btn("torch", "Light", () => PD.send({ type: "adb_input", id: v.id, t: "camera", what: "torch" }));
    btn("zoomIn", "Zoom in", () => PD.send({ type: "adb_input", id: v.id, t: "camera", what: "zoomIn" }));
    btn("zoomOut", "Zoom out", () => PD.send({ type: "adb_input", id: v.id, t: "camera", what: "zoomOut" }));
  } else {
    btn("volumeDown", "Volume down", () => navKey("volumeDown"));
    btn("volumeUp", "Volume up", () => navKey("volumeUp"));
    btn("rotate", "Rotate", () => (info.kind === "app" ? rotateApp(v) : navKey("rotate")));
    if (info.kind === "screen") {
      btn("notifications", "Notifications", () => navKey("notifications"));
      btn("settings", "Quick settings", () => navKey("settings"));
      btn("power", "Power (lock or wake)", () => navKey("power"));
      btn("screenOff", "Phone screen off (keeps showing here)", () => navKey("screenPower"));
    }
  }
  btn("shot", "Screenshot (copies it)", () => shot(v));
  v.recBtn = btn("record", "Record", () => record(v));
  if ("documentPictureInPicture" in window) btn("pip", "Pop out, always on top", () => popOut(v));
  btn("full", "Full screen", () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()));
  btn("close", "Close", () => PD.send({ type: "adb_close", id: v.id }));
  if (info.kind !== "camera") {
    btn("back", "Back (right click, Esc)", () => navKey("back"), nav);
    btn("home", "Home (middle click)", () => navKey("home"), nav);
    if (info.kind === "screen") btn("recents", "Recent apps", () => navKey("recents"), nav);
  }

  place(v);
  drag(v);
  wireInput(v);
  new ResizeObserver(() => {
    fit(v);
    if (info.kind === "app") {
      clearTimeout(v.resizeTimer);
      const scale = Math.max(2, devicePixelRatio);
      v.resizeTimer = setTimeout(() => PD.send({ type: "adb_input", id: v.id, t: "resize", w: Math.round(v.stage.clientWidth * scale), h: Math.round(v.stage.clientHeight * scale) }), 300);
    }
  }).observe(stage);
  el.addEventListener("pointerdown", () => front(v), true);
  front(v);
  setTimeout(() => canvas.focus(), 50);
  PD.emit("adb_views_changed");
  return v;
}

let z = 10;
function front(v) { v.el.style.zIndex = ++z; }
function place(v) {
  const host = document.getElementById("pwins");
  host.append(v.el);
  const n = PD.adb.views.size - 1;
  const h = Math.max(420, Math.min(780, innerHeight - 80));
  const audio = v.info.kind === "sound" || v.info.kind === "mic";
  const w = audio ? 320 : v.info.kind === "camera" ? Math.round(h * 0.75 * 16 / 9 * 0.6) : Math.round(h * 0.48);
  v.el.style.width = `${w}px`;
  v.el.style.height = `${audio ? 110 : h}px`;
  v.el.style.left = `${Math.min(innerWidth - w - 16, 240 + n * 36)}px`;
  v.el.style.top = `${Math.min(innerHeight - h - 16, 24 + n * 30)}px`;
}
function drag(v) {
  let start = null;
  v.bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    start = { x: e.clientX, y: e.clientY, l: v.el.offsetLeft, t: v.el.offsetTop };
    v.bar.setPointerCapture(e.pointerId);
  });
  v.bar.addEventListener("pointermove", (e) => {
    if (!start) return;
    v.el.style.left = `${Math.max(0, Math.min(innerWidth - 80, start.l + e.clientX - start.x))}px`;
    v.el.style.top = `${Math.max(0, Math.min(innerHeight - 40, start.t + e.clientY - start.y))}px`;
  });
  v.bar.addEventListener("pointerup", () => { start = null; });
  v.bar.addEventListener("dblclick", () => fitWindow(v));
}
/** Letterboxed: the canvas keeps the phone's aspect inside the window. */
function fit(v) {
  const w = v.canvas.width || v.info.w || 9, h = v.canvas.height || v.info.h || 19;
  const k = Math.min(v.stage.clientWidth / w, v.stage.clientHeight / h);
  v.canvas.style.width = `${Math.floor(w * k)}px`;
  v.canvas.style.height = `${Math.floor(h * k)}px`;
}
/** The window snaps round the picture, keeping its height. */
function fitWindow(v) {
  const w = v.canvas.width, h = v.canvas.height;
  if (!w || !h) return;
  const chrome = v.el.offsetHeight - v.stage.clientHeight;
  v.el.style.width = `${Math.round(v.stage.clientHeight * (w / h)) + (v.el.offsetWidth - v.stage.clientWidth)}px`;
  v.el.style.height = `${v.stage.clientHeight + chrome}px`;
}
function rotateApp(v) {
  const w = v.el.offsetWidth, h = v.el.offsetHeight;
  v.el.style.width = `${h}px`;
  v.el.style.height = `${w}px`;
}
function destroy(v) {
  PD.adb.views.delete(v.id);
  try { v.decoder?.close(); } catch {}
  try { v.adec?.close(); } catch {}
  try { v.actx?.close(); } catch {}
  v.rec?.stop();
  v.pip?.close();
  v.el.remove();
  PD.emit("adb_views_changed");
}

/** Always on top in a window of its own (Document Picture-in-Picture); input still works there. */
async function popOut(v) {
  if (v.pip) return v.pip.close();
  const pip = await documentPictureInPicture.requestWindow({ width: v.el.offsetWidth, height: v.el.offsetHeight });
  v.pip = pip;
  for (const s of document.querySelectorAll("style, link[rel=stylesheet]")) pip.document.head.append(s.cloneNode(true));
  pip.document.body.className = "pip " + document.body.className;
  pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme || "";
  const holder = document.createElement("div");
  v.el.replaceWith(holder);
  v.el.classList.add("popped");
  pip.document.body.append(v.el);
  pip.addEventListener("pagehide", () => {
    v.pip = null;
    v.el.classList.remove("popped");
    if (PD.adb.views.has(v.id)) holder.replaceWith(v.el); else holder.remove();
    fit(v);
  });
  fit(v);
}

// ── video ──
function codecString(kind, cfg) {
  if (kind === "h265") return "hev1.1.6.L153.B0";
  if (kind === "av1") return "av01.0.08M.08";
  for (let i = 0; i + 6 < cfg.length; i++) {
    if (cfg[i] === 0 && cfg[i + 1] === 0 && cfg[i + 2] === 1 && (cfg[i + 3] & 0x1f) === 7) {
      return "avc1." + [cfg[i + 4], cfg[i + 5], cfg[i + 6]].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  return "avc1.42e01f";
}
function needKey(v) {
  v.waitingKey = true;
  const now = performance.now();
  if (now - v.askedKey < 1000) return;
  v.askedKey = now;
  PD.send({ type: "adb_input", id: v.id, t: "resetVideo" });
}
function video(v, flags, pts, data) {
  const config = flags & 1, key = flags & 2;
  if (config) {
    v.config = data.slice();
    try { v.decoder?.close(); } catch {}
    v.decoder = new VideoDecoder({
      output: (frame) => {
        const c = v.canvas;
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth; c.height = frame.displayHeight;
          fit(v);
        }
        v.ctx.drawImage(frame, 0, 0);
        frame.close();
        if (v.status.textContent) { v.status.textContent = ""; v.status.hidden = true; }
      },
      error: () => needKey(v),
    });
    v.decoder.configure({ codec: codecString(v.info.codec || "h264", v.config), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    v.waitingKey = true;
    return;
  }
  const d = v.decoder;
  if (!d || d.state !== "configured") return;
  if (v.waitingKey && !key) return needKey(v);
  if (d.decodeQueueSize > 4 && !key) return needKey(v);
  let chunk = data;
  if (key && v.config && v.info.codec !== "av1") {
    chunk = new Uint8Array(v.config.length + data.length);
    chunk.set(v.config, 0);
    chunk.set(data, v.config.length);
  }
  v.waitingKey = false;
  try { d.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: pts, data: chunk })); } catch { needKey(v); }
}

// ── sound: Opus from the phone, played through a small jitter buffer ──
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.q=[];this.n=0;this.o=0;this.port.onmessage=e=>{this.q.push(e.data);this.n+=e.data.length;while(this.n>48000*2*0.2){this.n-=this.q.shift().length-this.o;this.o=0}}}
process(_,outs){const L=outs[0][0],R=outs[0][1];for(let i=0;i<L.length;i++){const b=this.q[0];if(!b){L[i]=R[i]=0;continue}L[i]=b[this.o];R[i]=b[this.o+1];this.o+=2;this.n-=2;if(this.o>=b.length){this.q.shift();this.o=0}}return true}}registerProcessor("pd-pcm",P)`;
async function audioOut(v) {
  v.actx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  await v.actx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  v.player = new AudioWorkletNode(v.actx, "pd-pcm", { outputChannelCount: [2] });
  v.player.connect(v.actx.destination);
  if (v.actx.state === "suspended") document.addEventListener("pointerdown", () => v.actx?.resume(), { once: true });
}
function audio(v, flags, pts, data) {
  if (flags & 1) return;
  if (!v.player) { v.audioStarting ||= audioOut(v).catch(() => {}); return; }
  if (v.audioCodec === "raw") {
    const s16 = new Int16Array(data.slice().buffer);
    const f = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
    return v.player.port.postMessage(f, [f.buffer]);
  }
  if (!v.adec || v.adec.state === "closed") {
    v.adec = new AudioDecoder({
      output: (a) => {
        const n = a.numberOfFrames, ch = [];
        for (let c = 0; c < Math.min(2, a.numberOfChannels); c++) { const p = new Float32Array(n); a.copyTo(p, { planeIndex: c, format: "f32-planar" }); ch.push(p); }
        a.close();
        const [l, r = l] = ch, f = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { f[i * 2] = l[i]; f[i * 2 + 1] = r[i]; }
        v.player.port.postMessage(f, [f.buffer]);
      },
      error: () => {},
    });
    v.adec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  }
  v.adec.decode(new EncodedAudioChunk({ type: "key", timestamp: pts, data }));
}

// ── input ──
function wireInput(v) {
  const c = v.canvas;
  const send = (o) => PD.send({ type: "adb_input", id: v.id, ...o });
  const at = (e) => {
    const r = c.getBoundingClientRect(), w = c.width || 1, h = c.height || 1;
    return { x: Math.max(0, Math.min(w - 1, ((e.clientX - r.left) / r.width) * w)), y: Math.max(0, Math.min(h - 1, ((e.clientY - r.top) / r.height) * h)) };
  };
  let down = false, right = null;
  c.addEventListener("pointerdown", (e) => {
    c.focus();
    if (e.button === 1) { e.preventDefault(); return send({ t: "nav", key: "home" }); }
    c.setPointerCapture(e.pointerId);
    if (e.button === 2) { right = { ...at(e), cx: e.clientX, cy: e.clientY, dragging: false }; return; }
    if (e.button !== 0) return;
    down = true;
    send({ t: "touch", action: ACTION.DOWN, pointer: FINGER, ...at(e) });
  });
  c.addEventListener("pointermove", (e) => {
    if (right) {
      if (!right.dragging && Math.hypot(e.clientX - right.cx, e.clientY - right.cy) > 5) {
        right.dragging = true;
        send({ t: "touch", action: ACTION.DOWN, pointer: FINGER, x: right.x, y: right.y });
      }
      if (right.dragging) send({ t: "touch", action: ACTION.MOVE, pointer: FINGER, ...at(e) });
      return;
    }
    if (down) send({ t: "touch", action: ACTION.MOVE, pointer: FINGER, ...at(e) });
    else if (v.info.kind !== "camera") send({ t: "touch", action: ACTION.HOVER_MOVE, pointer: -1, ...at(e) });
  });
  const up = (e) => {
    try { c.releasePointerCapture(e.pointerId); } catch {}
    if (right) {
      if (right.dragging) send({ t: "touch", action: ACTION.UP, pointer: FINGER, ...at(e) });
      else if (e.type === "pointerup") send({ t: "nav", key: "back" });
      right = null;
      return;
    }
    if (!down) return;
    down = false;
    send({ t: "touch", action: ACTION.UP, pointer: FINGER, ...at(e) });
  };
  c.addEventListener("pointerup", up);
  c.addEventListener("pointercancel", up);
  c.addEventListener("pointerleave", (e) => { if (!down && !right && v.info.kind !== "camera") send({ t: "touch", action: ACTION.HOVER_EXIT, pointer: -1, ...at(e) }); });
  c.addEventListener("contextmenu", (e) => e.preventDefault());
  let pinch = null;
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = at(e);
    if (e.ctrlKey) {
      const w = c.width || 1;
      if (!pinch) {
        pinch = { cx: p.x, cy: p.y, d: w * 0.08 };
        send({ t: "touch", action: ACTION.DOWN, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
        send({ t: "touch", action: ACTION.DOWN, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
      }
      pinch.d = Math.max(10, Math.min(w * 0.45, pinch.d * Math.exp(-e.deltaY / 60)));
      send({ t: "touch", action: ACTION.MOVE, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
      send({ t: "touch", action: ACTION.MOVE, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
      clearTimeout(pinch.timer);
      pinch.timer = setTimeout(() => {
        send({ t: "touch", action: ACTION.UP, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
        send({ t: "touch", action: ACTION.UP, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
        pinch = null;
      }, 160);
      return;
    }
    const k = e.deltaMode === 1 ? 1 : 1 / 100;
    send({ t: "scroll", ...p, hs: -e.deltaX * k, vs: -e.deltaY * k });
  }, { passive: false });
  const key = async (e) => {
    if (e.key === "F11") return;
    // Ctrl+V: this PC's clipboard pasted on the phone.
    if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.code === "KeyV") {
      e.preventDefault();
      try { const t = await navigator.clipboard.readText(); if (t) send({ t: "paste", text: t }); } catch {}
      return;
    }
    if (e.type === "keydown" && e.code === "Escape" && !e.shiftKey) { e.preventDefault(); return send({ t: "nav", key: "back" }); }
    e.preventDefault();
    if (e.type === "keydown") v.keysDown.add(e.code); else v.keysDown.delete(e.code);
    send({ t: "key", code: e.code, down: e.type === "keydown", repeat: e.repeat, enterSends: PD.adb.settings.enterSends });
  };
  c.addEventListener("keydown", key);
  c.addEventListener("keyup", key);
  c.addEventListener("blur", () => {
    if (down) { down = false; send({ t: "touch", action: ACTION.UP, pointer: FINGER, x: 0, y: 0 }); }
    for (const code of v.keysDown) send({ t: "key", code, down: false });
    v.keysDown.clear();
  });
  // Files dropped on the window land in the phone's Downloads.
  v.el.addEventListener("dragover", (e) => { e.preventDefault(); v.el.classList.add("drop"); });
  v.el.addEventListener("dragleave", (e) => { if (!v.el.contains(e.relatedTarget)) v.el.classList.remove("drop"); });
  v.el.addEventListener("drop", (e) => { e.preventDefault(); v.el.classList.remove("drop"); PD.adb.pushFiles(e.dataTransfer.files); });
}

// ── screenshots, recording, files ──
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }
function b64Blob(b64, type) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}
async function saveBlob(blob, name, copy) {
  if (copy && blob.type === "image/png") {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); PD.toast("Screenshot copied; also saved"); } catch {}
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function shot(v) {
  if (!v.canvas.width) return;
  v.canvas.toBlob((b) => b && saveBlob(b, `${v.info.label || "phone"}-${stamp()}.png`, true), "image/png");
}
function record(v) {
  if (v.rec) { v.rec.stop(); return; }
  const audioOnly = v.info.kind === "sound" || v.info.kind === "mic";
  if (audioOnly && !v.player) return PD.toast("No sound yet from the phone", true);
  const stream = audioOnly ? new MediaStream() : v.canvas.captureStream(60);
  if (v.actx && v.player) {
    const dest = v.actx.createMediaStreamDestination();
    v.player.connect(dest);
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  }
  const type = (audioOnly ? ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"] : ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm"]).find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = () => {
    v.rec = null;
    v.recBtn.classList.remove("on");
    saveBlob(new Blob(parts, { type: rec.mimeType }), `${v.info.label || "phone"}-${stamp()}.${type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm"}`);
  };
  rec.start(1000);
  v.rec = rec;
  v.recBtn.classList.add("on");
}

const CHUNK = 384 << 10;
let pushRid = 0;
const pushWait = new Map();
PD.on("adb_push", (m) => { const w = pushWait.get(m.rid); if (w) { pushWait.delete(m.rid); m.ok ? w.resolve(m) : w.reject(new Error(m.error)); } });
function pushCall(o) {
  return new Promise((resolve, reject) => {
    const rid = ++pushRid;
    pushWait.set(rid, { resolve, reject });
    PD.send({ type: "adb_push", rid, ...o });
    setTimeout(() => { if (pushWait.delete(rid)) reject(new Error("no answer")); }, 180000);
  });
}
PD.adb.pushFiles = async (files) => {
  for (const f of files) {
    try {
      for (let offset = 0; ; offset += CHUNK) {
        const bytes = new Uint8Array(await f.slice(offset, offset + CHUNK).arrayBuffer());
        const last = offset + CHUNK >= f.size;
        await pushCall({ name: f.name, data: PD.b64(bytes), offset, last });
        PD.toast(last ? `${f.name} is in the phone's Downloads` : `Sending ${f.name}: ${Math.floor(((offset + CHUNK) / f.size) * 100)}%`);
        if (last) break;
      }
    } catch (e) { PD.toast(`${f.name}: ${e.message}`, true); }
  }
};
})();
