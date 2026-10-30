// SPDX-License-Identifier: GPL-3.0-or-later
// The Computers page: every screen this PC reaches (its phones, other PCs running PocketDesk on
// Windows, macOS or Linux, and their phones), each in a window of its own with mouse, keyboard and
// clipboard. A window has its own socket to this daemon, which relays to wherever the screen is.
"use strict";

(() => {
const PD = window.PD;
const { h, $ } = PD;
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });
const OS = { win32: "Windows", darwin: "Mac", linux: "Linux", android: "Android" };

PD.computers = { saved: [], sources: [], nested: new Map(), wins: new Map() };
const C = PD.computers;
PD.on("pc_list", (m) => { C.saved = m.items || []; PD.emit("computers_changed"); });
PD.on("sources_list", (m) => {
  if (m.of) C.nested.set(m.of, (m.items || []).filter((x) => x.id !== m.of));
  else {
    C.sources = (m.items || []).filter((x) => x.id !== "local");
    for (const s of C.sources) if (s.kind === "pc") PD.send({ type: "sources_list", of: s.id });
  }
  PD.emit("computers_changed");
});
PD.on("pc_error", (m) => PD.toast(m.message, true));
PD.on("pc_pairing_link", async (m) => {
  try { await navigator.clipboard.writeText(m.link); PD.toast("This PC's link is copied: paste it on the other PC's Computers page"); }
  catch { prompt("This PC's link, for the other PC's Computers page", m.link); }
});
PD.on("kvm", (m) => { C.kvm = m; PD.emit("computers_changed"); });
const refresh = () => { PD.send({ type: "pc_list" }); PD.send({ type: "sources_list" }); PD.send({ type: "kvm_get" }); };
PD.on("welcome", refresh);

PD.page("computers", {
  title: "Computers",
  icon: '<svg viewBox="0 0 20 20"><rect x="2.5" y="4" width="10" height="7.5" rx="1"/><path d="M5.5 15h4M7.5 11.5V15"/><rect x="13.5" y="7" width="4.5" height="8.5" rx="1"/></svg>',
  render(sec) {
    const grid = h("div", { className: "grid" });
    const link = h("textarea", { rows: 2, placeholder: "pocketdesk://pair#…  (or wss://address:8765/ws)" });
    const token = h("input", { type: "text", placeholder: "Token, only with a wss:// address" });
    const kvm = h("div", { className: "card col" });
    const pass = h("input", { type: "password", placeholder: "Its connection password, if it has one", autocomplete: "off" });
    const add = () => {
      const v = link.value.trim();
      if (!v) return PD.toast("Paste the other PC's link first", true);
      PD.send(v.startsWith("pocketdesk://") ? { type: "pc_add", link: v, password: pass.value || undefined }
        : { type: "pc_add", url: v, token: token.value.trim(), password: pass.value || undefined });
      link.value = ""; pass.value = ""; token.value = "";
    };
    sec.append(
      h("div", { className: "bar" }, btn("Refresh", refresh), btn("Copy this PC's link", () => PD.send({ type: "pc_pairing_link" }))),
      h("p", { className: "dim small", textContent: "Phones on this PC, other PCs with PocketDesk (Windows, Mac or Linux) and their phones. Open one and drive it with this PC's mouse and keyboard; Ctrl+V pastes this PC's clipboard there." }),
      grid,
      kvm,
      h("div", { className: "card col" },
        h("b", { textContent: "Add a PC" }),
        h("span", { className: "dim small", textContent: "On the other PC open PocketDesk's page, go to Computers and press \"Copy this PC's link\", then paste it here. Both PCs need to be on the same network, or reachable over a VPN." }),
        link, token, pass, h("div", { className: "bar" }, btn("Add", add, "primary"))));
    const draw = () => {
      const card = (s, nestedIn) => h("div", { className: "card col" },
        h("div", { className: "row" },
          h("b", { className: "grow", textContent: s.name }),
          h("span", { className: "pill", textContent: s.kind === "phone" ? (s.via === "app" ? "Phone · app" : "Phone") : OS[s.os] || "PC" })),
        h("span", { className: "dim small", textContent: nestedIn ? `through ${nestedIn}` : s.id.startsWith("pc:") ? (s.online ? "linked" : "saved") : s.id === "share" ? "asks on the phone first" : "on this PC" }),
        h("div", { className: "bar" },
          btn("Open", () => openWin(s), "primary"),
          s.id.startsWith("pc:") && !nestedIn ? btn("Rename", () => { const n = prompt("Name", s.name); if (n) PD.send({ type: "pc_rename", id: s.id.slice(3), name: n }); }) : "",
          s.id.startsWith("pc:") && !nestedIn ? btn("Remove", () => confirm(`Remove ${s.name}? Adding it again needs its link.`) && PD.send({ type: "pc_remove", id: s.id.slice(3) })) : ""));
      const cards = [];
      for (const s of C.sources) {
        cards.push(card(s));
        for (const n of C.nested.get(s.id) || []) cards.push(card(n, s.name));
      }
      drawKvm();
      grid.replaceChildren(...(cards.length ? cards : [h("p", { className: "dim", textContent: "Nothing yet: set up a phone on the Connect page, or add a PC below." })]));
    };
    function drawKvm() {
      const k = C.kvm;
      if (!k) return kvm.replaceChildren(h("b", { textContent: "Shared mouse and keyboard" }));
      const set = (o) => PD.send({ type: "kvm_set", ...o });
      const target = h("select", { onchange: () => set({ target: target.value || null }) },
        h("option", { value: "", textContent: "Choose a PC" }),
        C.saved.map((p) => h("option", { value: p.id, textContent: p.name, selected: p.id === k.target })));
      const side = h("select", { onchange: () => set({ side: side.value }) },
        ["left", "right", "top", "bottom"].map((s) => h("option", { value: s, textContent: `Past the ${s} edge`, selected: s === k.side })));
      const status = !k.supported ? "This side needs Windows; a Mac or Linux PC can still be the one driven."
        : k.error ? k.error : !k.on ? "Off." : k.away ? "The pointer is on the other PC. Scroll Lock brings it back."
          : k.linked ? "On: push the pointer past the edge to cross." : "Waiting for the other PC…";
      kvm.replaceChildren(
        h("b", { textContent: "Shared mouse and keyboard" }),
        h("span", { className: "dim small", textContent: "One mouse and keyboard for two PCs, the clipboard shared between them. Push the pointer past the edge where the other PC stands; come back the same way, or press Scroll Lock." }),
        h("div", { className: "bar" },
          h("label", { className: "check" }, h("input", { type: "checkbox", checked: !!k.on, disabled: !k.supported, onchange: (e) => set({ on: e.target.checked, target: target.value || null }) }), h("span", { textContent: "On" })),
          target, side),
        h("span", { className: `small ${k.error ? "bad" : "dim"}`, textContent: status }));
    }
    PD.on("computers_changed", draw);
    draw();
  },
  show: refresh,
});

// ── a window per screen ──
const VK = (() => {
  const m = { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
    AltLeft: 0xa4, AltRight: 0xa5, Pause: 0x13, CapsLock: 0x14, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 0x2c, Insert: 45, Delete: 46, MetaLeft: 0x5b, MetaRight: 0x5c,
    ContextMenu: 0x5d, NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
    NumLock: 0x90, ScrollLock: 0x91, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
    Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
    AudioVolumeMute: 0xad, AudioVolumeDown: 0xae, AudioVolumeUp: 0xaf, MediaTrackNext: 0xb0, MediaTrackPrevious: 0xb1, MediaPlayPause: 0xb3 };
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
  for (let i = 0; i < 10; i++) { m[`Digit${i}`] = 48 + i; m[`Numpad${i}`] = 0x60 + i; }
  for (let i = 1; i <= 12; i++) m[`F${i}`] = 0x6f + i;
  return m;
})();
const BUTTONS = ["left", "middle", "right"];
const SWAP = { 0xa2: 0x5b, 0xa3: 0x5c, 0x5b: 0xa2, 0x5c: 0xa3 };
// [label, virtual key, modifiers]; "win" is Cmd on a Mac and Super on Linux.
const SHORTCUTS = {
  win32: [["Start", 0x5b, []], ["Task view", 0x09, ["win"]], ["Show desktop", 0x44, ["win"]], ["Alt+Tab", 0x09, ["alt"]],
    ["Task Manager", 0x1b, ["ctrl", "shift"]], ["Lock", 0x4c, ["win"]], ["Close window", 0x73, ["alt"]]],
  darwin: [["Spotlight", 0x20, ["win"]], ["Mission Control", 0x26, ["ctrl"]], ["App switcher", 0x09, ["win"]], ["Close window", 0x57, ["win"]],
    ["Quit app", 0x51, ["win"]], ["Force Quit", 0x1b, ["win", "alt"]], ["Lock screen", 0x51, ["ctrl", "win"]], ["Screenshot", 0x34, ["win", "shift"]]],
  linux: [["Activities", 0x5b, []], ["Alt+Tab", 0x09, ["alt"]], ["Show desktop", 0x44, ["win"]], ["Close window", 0x73, ["alt"]], ["Lock", 0x4c, ["win"]]],
};
let z = 2000;

function openWin(s) {
  const open = [...C.wins.values()].find((w) => w.source === s.id);
  if (open) { open.el.style.zIndex = ++z; return; }
  const phone = s.kind === "phone";
  const canvas = h("canvas", { tabIndex: 0 });
  const status = h("div", { className: "pwin-status", textContent: s.id === "share" ? "Waiting for the phone to say yes…" : "Connecting…" });
  const stage = h("div", { className: "pwin-stage" }, canvas, status);
  const title = h("span", { className: "pwin-title", textContent: s.name });
  const tools = h("span", { className: "pwin-tools" });
  const bar = h("div", { className: "pwin-bar" }, title, tools);
  const el = h("div", { className: `pwin k-${phone ? "screen" : "pc"}`, tabIndex: -1 }, bar, stage);
  const w = { source: s.id, el, canvas, status, ctx: canvas.getContext("2d", { alpha: false, desynchronized: true }), held: new Set(), monitors: [], monitor: 0, mode: "" };
  C.wins.set(w, w);
  const tool = (k, label, fn) => {
    const b = h("button", { className: "ic", title: label, innerHTML: PD.icon(k), onclick: (e) => { e.stopPropagation(); fn(b); canvas.focus(); } });
    b.setAttribute("aria-label", label);
    tools.append(b);
    return b;
  };
  const mon = h("select", { title: "Screen", style: "display:none", onchange: () => { w.monitor = Number(mon.value); start(); } });
  tools.append(mon);
  const nav = (key) => send({ type: "desktop_nav", key });
  if (phone) {
    tool("back", "Back (right click)", () => nav("back"));
    tool("home", "Home (middle click)", () => nav("home"));
    tool("recents", "Recent apps", () => nav("recents"));
    tool("notifications", "Notifications", () => nav("notifications"));
  } else {
    // Shortcuts spelled for the OS on the other end, filled in once it says which.
    w.keys = h("select", { title: "Shortcuts", onchange: () => {
      const c = SHORTCUTS[w.os]?.[Number(w.keys.value)] || SHORTCUTS.win32[Number(w.keys.value)];
      if (c && !w.viewOnly) send({ type: "desktop_key", key: c[1], modifiers: c[2] });
      w.keys.value = "";
      canvas.focus();
    } });
    tools.append(w.keys);
  }
  tool("shot", "Screenshot (copies it)", () => canvas.toBlob(async (b) => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); PD.toast("Screenshot copied"); } catch { PD.toast("Could not copy", true); }
  }));
  tool("full", "Full screen", () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()));
  tool("close", "Close", () => close());

  const host = document.getElementById("pwins");
  host.append(el);
  const n = C.wins.size - 1;
  const hgt = Math.max(360, Math.min(720, innerHeight - 80));
  const wid = phone ? Math.round(hgt * 0.48) : Math.min(innerWidth - 32, Math.round(hgt * 16 / 9));
  Object.assign(el.style, { width: `${wid}px`, height: `${hgt}px`, left: `${Math.max(8, Math.min(innerWidth - wid - 16, 200 + n * 36))}px`, top: `${Math.max(8, 24 + n * 30)}px`, zIndex: ++z });
  el.addEventListener("pointerdown", () => { el.style.zIndex = ++z; }, true);
  let drag = null;
  bar.addEventListener("pointerdown", (e) => { if (e.target.closest("button,select")) return; drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop }; bar.setPointerCapture(e.pointerId); });
  bar.addEventListener("pointermove", (e) => { if (drag) { el.style.left = `${drag.l + e.clientX - drag.x}px`; el.style.top = `${Math.max(0, drag.t + e.clientY - drag.y)}px`; } });
  bar.addEventListener("pointerup", () => { drag = null; });
  const fit = () => {
    const cw = canvas.width || 16, ch = canvas.height || 9;
    const k = Math.min(stage.clientWidth / cw, stage.clientHeight / ch);
    canvas.style.width = `${Math.floor(cw * k)}px`;
    canvas.style.height = `${Math.floor(ch * k)}px`;
  };
  new ResizeObserver(fit).observe(stage);

  // Its own socket, so each window has its own stream; the daemon routes it to the source.
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  w.send = send;
  const start = () => {
    send({ type: "desktop_start", video: true, preset: "balanced", monitor: w.monitor, codecs: ["h264"], audio: !phone && typeof AudioDecoder === "function", source: s.id });
    send({ type: "desktop_monitors" });
  };
  ws.onopen = () => send({ type: "hello", token: $("#token").value.trim(), name: `PC browser (${s.name})` });
  ws.onclose = () => { if (C.wins.has(w)) { status.hidden = false; status.textContent = "Disconnected"; } };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return packet(w, new Uint8Array(ev.data), fit);
    const m = JSON.parse(ev.data);
    if (m.type === "welcome") start();
    else if (m.type === "desktop_started") {
      if (!m.ok) { status.hidden = false; status.textContent = m.reason || "Could not open it"; return; }
      w.mode = m.mode;
      w.os = m.os || s.os || "win32";
      if (w.keys) w.keys.replaceChildren(h("option", { value: "", textContent: "Keys…" }),
        (SHORTCUTS[w.os] || SHORTCUTS.win32).map((c, i) => h("option", { value: i, textContent: c[0] })));
      // A PC keyboard on a Mac: Ctrl and Cmd trade places, so Ctrl+C copies there as here.
      w.swap = w.os === "darwin" && !/Mac/i.test(navigator.platform);
      w.viewOnly = !!m.viewOnly;
      title.textContent = `${s.name}${m.viewOnly ? " · view only" : ""}`;
    } else if (m.type === "desktop_frame" && m.base64 && w.mode !== "h264") {
      const img = new Image();
      img.onload = () => { size(w, img.width, img.height, fit); w.ctx.drawImage(img, 0, 0); status.hidden = true; };
      img.src = `data:image/jpeg;base64,${m.base64}`;
    } else if (m.type === "desktop_monitors" && m.ok) {
      w.monitors = m.monitors || [];
      mon.style.display = w.monitors.length < 2 ? "none" : "";
      mon.replaceChildren(...w.monitors.map((x, i) => h("option", { value: i, textContent: `Screen ${i + 1}${x.primary ? " (main)" : ""}`, selected: i === w.monitor })));
    } else if (m.type === "desktop_stopped" && m.why) {
      status.hidden = false;
      status.textContent = m.why;
    } else if (m.type === "desktop_input_ok" && !m.ok && m.error) PD.toast(`${s.name}: ${m.error}`, true);
  };

  // ── input ──
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    return fx < 0 || fy < 0 || fx > 1 || fy > 1 ? null : { fx, fy, x: Math.round(fx * canvas.width), y: Math.round(fy * canvas.height) };
  };
  let lastMove = 0;
  canvas.addEventListener("pointermove", (e) => {
    const now = performance.now();
    if (now - lastMove < 12 || w.viewOnly) return;
    lastMove = now;
    const p = at(e);
    if (p) send({ type: "desktop_mouse", ...p });
  });
  for (const [evt, press] of [["pointerdown", "down"], ["pointerup", "up"]]) {
    canvas.addEventListener(evt, (e) => {
      const button = BUTTONS[e.button], p = at(e);
      if (!button || !p || w.viewOnly) return;
      if (press === "down") { canvas.focus(); canvas.setPointerCapture(e.pointerId); w.held.add(`b:${button}`); } else w.held.delete(`b:${button}`);
      send({ type: "desktop_mouse", ...p, press, button });
      e.preventDefault();
    });
  }
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (w.viewOnly) return;
    e.preventDefault();
    const amount = (d) => Math.max(-1200, Math.min(1200, Math.round((e.deltaMode === 1 ? d * 40 : d) * 1.2)));
    const p = at(e) || {};
    if (e.deltaY) send({ type: "desktop_mouse", ...p, wheel: -amount(e.deltaY) });
    if (e.deltaX) send({ type: "desktop_mouse", ...p, hwheel: amount(e.deltaX) });
  }, { passive: false });
  const tap = (vk) => send({ type: "desktop_key", key: vk });
  for (const [evt, press] of [["keydown", "down"], ["keyup", "up"]]) {
    canvas.addEventListener(evt, (e) => {
      let vk = VK[e.code];
      if (w.swap && SWAP[vk]) vk = SWAP[vk];
      if (!vk || w.viewOnly) return;
      // Ctrl+V pastes this PC's clipboard there instead (the paste event below).
      if (e.code === "KeyV" && (e.ctrlKey || e.metaKey)) return;
      if (press === "down") w.held.add(`k:${vk}`); else w.held.delete(`k:${vk}`);
      send({ type: "desktop_key", key: vk, press });
      e.preventDefault();
    });
  }
  const onPaste = (e) => {
    const text = e.clipboardData.getData("text/plain");
    if (document.activeElement !== canvas || !text || w.viewOnly) return;
    e.preventDefault();
    send({ type: "clipboard_set", text, paste: true });
  };
  document.addEventListener("paste", onPaste);
  // Keys or buttons still down when focus leaves would stay down over there.
  canvas.addEventListener("blur", () => {
    for (const k of w.held) {
      if (k.startsWith("k:")) send({ type: "desktop_key", key: Number(k.slice(2)), press: "up" });
      else send({ type: "desktop_mouse", press: "up", button: k.slice(2) });
    }
    w.held.clear();
  });
  setTimeout(() => canvas.focus(), 50);

  function close() {
    C.wins.delete(w);
    document.removeEventListener("paste", onPaste);
    try { w.decoder?.close(); } catch {}
    try { w.actx?.close(); } catch {}
    send({ type: "desktop_stop" });
    ws.close();
    el.remove();
  }
}

function size(w, cw, ch, fit) {
  if (w.canvas.width === cw && w.canvas.height === ch) return;
  w.canvas.width = cw; w.canvas.height = ch;
  fit();
}

/** The desktop stream: [kind, ...data], 0 config, 1 keyframe, 2 delta, 3 an AAC frame. */
function packet(w, b, fit) {
  const kind = b[0], data = b.subarray(1);
  if (kind === 3) return audio(w, data);
  if (kind === 0) {
    w.config = data.slice();
    try { w.decoder?.close(); } catch {}
    w.decoder = new VideoDecoder({
      output: (frame) => {
        size(w, frame.displayWidth, frame.displayHeight, fit);
        w.ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!w.status.hidden) w.status.hidden = true;
      },
      error: () => { w.decoder = null; },
    });
    let codec = "avc1.42e01f";
    for (let i = 0; i + 6 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
        codec = `avc1.${[data[i + 4], data[i + 5], data[i + 6]].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
        break;
      }
    }
    w.decoder.configure({ codec, optimizeForLatency: true });
    w.needKey = true;
    return;
  }
  const d = w.decoder;
  if (!d || d.state !== "configured") return;
  if (w.needKey && kind !== 1) return;
  w.needKey = false;
  let chunk = data;
  if (kind === 1 && w.config) { chunk = new Uint8Array(w.config.length + data.length); chunk.set(w.config); chunk.set(data, w.config.length); }
  w.ts = (w.ts || 0) + 16_000;
  try { d.decode(new EncodedVideoChunk({ type: kind === 1 ? "key" : "delta", timestamp: w.ts, data: chunk })); } catch { w.needKey = true; }
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** One AAC-LC ADTS frame, played back to back. */
function audio(w, f) {
  if (f.length < 7 || f[0] !== 0xff || (f[1] & 0xf6) !== 0xf0) return;
  if (!w.adec) {
    const ri = (f[2] >> 2) & 0x0f, ch = (((f[2] & 1) << 2) | (f[3] >> 6)) || 2, rate = RATES[ri] || 48000;
    w.actx = new AudioContext({ sampleRate: rate });
    w.aNext = 0;
    try {
      w.adec = new AudioDecoder({
        output: (d) => {
          const buf = w.actx.createBuffer(d.numberOfChannels, d.numberOfFrames, d.sampleRate);
          const tmp = new Float32Array(d.numberOfFrames);
          for (let c = 0; c < d.numberOfChannels; c++) { d.copyTo(tmp, { planeIndex: c, format: "f32-planar" }); buf.copyToChannel(tmp.slice(), c); }
          d.close();
          const src = w.actx.createBufferSource();
          src.buffer = buf; src.connect(w.actx.destination);
          const now = w.actx.currentTime;
          if (w.aNext < now + 0.02 || w.aNext > now + 0.5) w.aNext = now + 0.05;
          src.start(w.aNext); w.aNext += buf.duration;
        },
        error: () => {},
      });
      w.adec.configure({ codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: ch, description: new Uint8Array([(2 << 3) | (ri >> 1), ((ri & 1) << 7) | (ch << 3)]) });
    } catch { w.adec = null; return; }
  }
  if (w.adec.state !== "configured") return;
  try { w.adec.decode(new EncodedAudioChunk({ type: "key", timestamp: (w.aTs = (w.aTs || 0) + 1024), data: f.subarray(7) })); } catch {}
}
})();
