// SPDX-License-Identifier: GPL-3.0-or-later
// The Timeline page, the command palette (Ctrl+K), this PC's game controllers on the phone, and
// the switches for what flows by itself (clipboard, this PC's notifications).
"use strict";

(() => {
const PD = window.PD;
const { h, $ } = PD;
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });

// ── what flows by itself ──
PD.sync = { clipSync: false, pcNotifs: false };
PD.on("phone_sync", (m) => { Object.assign(PD.sync, m); PD.emit("sync_changed"); });
PD.on("welcome", () => { PD.send({ type: "phone_sync_get" }); PD.send({ type: "timeline_list" }); });
PD.syncCard = (which) => {
  const card = h("div", { className: "card" });
  const draw = () => {
    const s = PD.sync;
    const row = (key, label, note, ok = true) => h("label", { className: "check" },
      h("input", { type: "checkbox", checked: !!s[key], disabled: !ok, onchange: (e) => PD.send({ type: "phone_sync_set", [key]: e.target.checked }) }),
      h("span", {}, h("b", { textContent: label }), h("span", { className: "dim", textContent: ` ${note}` })));
    card.replaceChildren(which === "clip"
      ? row("clipSync", "Sync the clipboard", "Copy on the PC, paste on the phone, and back. Text both ways; pictures to the phone through its app. Things password managers copy stay on the phone.", s.clipSupported !== false)
      : row("pcNotifs", "Show this PC's notifications on the phone", s.pcNotifsSupported === false ? "Windows only." : "Through the phone app; each one appears in its own Android notification.", s.pcNotifsSupported !== false));
  };
  PD.on("sync_changed", draw);
  draw();
  return card;
};

// ── Timeline ──
const KIND = { notif: "Notification", call: "Call", sms: "Text", clip: "Clipboard", file: "File", shot: "Screenshot" };
PD.timeline = [];
PD.on("timeline", (m) => { PD.timeline = m.items || []; PD.emit("timeline_changed"); });
PD.on("timeline_added", (m) => { PD.timeline.unshift(m.item); PD.emit("timeline_changed"); });
PD.page("timeline", {
  title: "Timeline",
  icon: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 2"/></svg>',
  render(sec) {
    const q = h("input", { type: "search", placeholder: "Search everything that moved", oninput: () => ask() });
    const kind = h("select", { onchange: () => ask() }, h("option", { value: "", textContent: "All" }), Object.entries(KIND).map(([k, v]) => h("option", { value: k, textContent: v })));
    const list = h("div", { className: "list" });
    let timer;
    const ask = () => { clearTimeout(timer); timer = setTimeout(() => PD.send({ type: "timeline_list", q: q.value, kind: kind.value }), 200); };
    sec.append(h("div", { className: "bar" }, q, kind, btn("Clear", () => confirm("Clear the timeline on this PC?") && PD.send({ type: "timeline_clear" }))),
      h("p", { className: "dim small", textContent: "Kept on this PC for 7 days." }), list);
    const draw = () => {
      list.replaceChildren(...PD.timeline.map((e) => h("div", { className: "item row" },
        h("span", { className: `pill k-${e.kind}`, textContent: KIND[e.kind] || e.kind }),
        h("div", { className: "grow" }, h("b", { textContent: e.title }), e.app ? h("span", { className: "dim small", textContent: ` · ${e.app}` }) : "",
          e.text ? h("div", { className: "dim clip", textContent: e.text }) : ""),
        h("span", { className: "dim small", textContent: new Date(e.at).toLocaleString() }),
        e.text ? btn("Copy", () => navigator.clipboard.writeText(e.text).then(() => PD.toast("Copied"))) : "")));
      if (!PD.timeline.length) list.append(h("div", { className: "empty", textContent: "Nothing yet." }));
    };
    PD.on("timeline_changed", draw);
  },
  show() { PD.send({ type: "timeline_list" }); },
});

// ── command palette ──
const box = h("div", { id: "palette", hidden: true });
const input = h("input", { type: "search", placeholder: "Type a command, a page, an app or a contact" });
const results = h("div", { className: "list" });
box.append(h("div", { className: "palette-card" }, input, results));
document.body.append(box);
let picks = [], sel = 0;
function commands() {
  const out = [];
  for (const a of document.querySelectorAll("#nav a")) out.push({ label: `Go to ${a.textContent}`, run: () => PD.go(a.dataset.page) });
  const ready = !!PD.adb.state?.serial;
  if (ready) {
    out.push({ label: "Show phone screen", run: () => PD.adb.open("screen") });
    out.push({ label: "Phone sound only", run: () => PD.adb.open("sound") });
    out.push({ label: "Back camera", run: () => PD.adb.open("camera", { facing: "back" }) });
    out.push({ label: "Front camera", run: () => PD.adb.open("camera", { facing: "front" }) });
    out.push({ label: "Phone screenshot", run: () => PD.send({ type: "adb_screenshot" }) });
    out.push({ label: "Lock the phone", run: () => PD.send({ type: "adb_action", action: "lock" }) });
    out.push({ label: "Wake the phone", run: () => PD.send({ type: "adb_action", action: "wake" }) });
    for (const a of PD.adb.apps) out.push({ label: `Open ${a.label}`, hint: a.pkg, run: () => PD.adb.open("app", { pkg: a.pkg, label: a.label }) });
  }
  if (PD.hub.online) {
    out.push({ label: "Find my phone", run: () => PD.ask("find", "ring").then(() => PD.toast("Ringing the phone")) });
    out.push({ label: "Stop ringing", run: () => PD.ask("find", "stop") });
    out.push({ label: "Do not disturb on", run: () => PD.ask("toggles", "set", { id: "dnd", on: true }) });
    out.push({ label: "Do not disturb off", run: () => PD.ask("toggles", "set", { id: "dnd", on: false }) });
    out.push({ label: "Play or pause the phone's music", run: () => PD.ask("media", PD.hub.state.media?.playing ? "pause" : "play") });
    out.push({ label: "Next track on the phone", run: () => PD.ask("media", "next") });
  }
  out.push({ label: "Send this PC's clipboard to the phone", run: async () => { const t = await navigator.clipboard.readText(); ready ? PD.send({ type: "adb_clipboard_set", text: t }) : PD.ask("clip", "set", { text: t }); PD.toast("On the phone's clipboard"); } });
  return out;
}
function render() {
  const q = input.value.trim().toLowerCase();
  const all = commands();
  picks = (q ? all.filter((c) => `${c.label} ${c.hint || ""}`.toLowerCase().includes(q)) : all).slice(0, 12);
  // A number typed in: call or text it from the phone.
  if (/^\+?[\d\s()-]{3,}$/.test(q) && PD.hub.online) {
    const n = q.replace(/[^\d+]/g, "");
    picks.unshift({ label: `Call ${n}`, run: () => PD.ask("calls", "dial", { number: n }) }, { label: `Text ${n}`, run: () => { PD.go("messages"); PD.newText?.(n); } });
  }
  sel = Math.min(sel, Math.max(0, picks.length - 1));
  results.replaceChildren(...picks.map((c, i) => h("button", { className: `item${i === sel ? " on" : ""}`, onclick: () => pick(i) },
    c.label, c.hint ? h("span", { className: "dim small", textContent: ` ${c.hint}` }) : "")));
}
function pick(i) {
  const c = picks[i];
  close();
  if (c) Promise.resolve().then(c.run).catch((e) => PD.toast(e.message, true));
}
function open() { box.hidden = false; input.value = ""; sel = 0; render(); input.focus(); }
function close() { box.hidden = true; }
PD.palette = open;
input.addEventListener("input", () => { sel = 0; render(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { sel = Math.min(picks.length - 1, sel + 1); render(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
  else if (e.key === "Enter") pick(sel);
  else if (e.key === "Escape") close();
});
box.addEventListener("pointerdown", (e) => { if (e.target === box) close(); });
document.addEventListener("keydown", (e) => {
  // Not while typing into the phone: its windows take every key.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.target.closest?.(".pwin")) { e.preventDefault(); box.hidden ? open() : close(); }
});

// ── game controllers: this PC's gamepads become the phone's, through phone control ──
const pads = new Map(); // index -> last report sent
let padOn = false;
try { padOn = localStorage.getItem("pd_pad") === "1"; } catch {}
PD.padCard = () => {
  const status = h("span", { className: "dim" });
  const box = h("label", { className: "check" }, h("input", { type: "checkbox", checked: padOn, onchange: (e) => { padOn = e.target.checked; try { localStorage.setItem("pd_pad", padOn ? "1" : "0"); } catch {} if (!padOn) release(); } }),
    h("span", {}, h("b", { textContent: "Game controllers on the phone" }), h("span", { className: "dim", textContent: " A controller plugged into this PC acts as an Xbox controller plugged into the phone, while this page is in front. " }), status));
  const tick = () => {
    const n = [...(navigator.getGamepads?.() || [])].filter(Boolean).length;
    status.textContent = n ? `${n} controller${n > 1 ? "s" : ""} found.` : "No controller found: press a button on it.";
  };
  addEventListener("gamepadconnected", tick);
  addEventListener("gamepaddisconnected", tick);
  tick();
  return h("div", { className: "card" }, box);
};
function release() {
  for (const i of pads.keys()) PD.send({ type: "adb_gamepad", pad: i, connected: false });
  pads.clear();
}
function poll() {
  requestAnimationFrame(poll);
  if (!padOn || !PD.adb.state?.serial || document.hidden) return;
  const seen = new Set();
  for (const g of navigator.getGamepads?.() || []) {
    if (!g || g.mapping !== "standard" || g.index > 3) continue;
    seen.add(g.index);
    const buttons = g.buttons.map((b) => Math.round(b.value * 100) / 100);
    const axes = g.axes.map((a) => (Math.abs(a) < 0.08 ? 0 : Math.round(a * 1000) / 1000));
    const key = `${buttons}|${axes}`;
    if (pads.get(g.index) === key) continue;
    pads.set(g.index, key);
    PD.send({ type: "adb_gamepad", pad: g.index, buttons, axes });
  }
  for (const i of [...pads.keys()]) if (!seen.has(i)) { pads.delete(i); PD.send({ type: "adb_gamepad", pad: i, connected: false }); }
}
requestAnimationFrame(poll);
document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });
})();
