// SPDX-License-Identifier: GPL-3.0-or-later
// Without phone control set up, the phone app can still share its screen on its owner's consent
// (Android's capture prompt) and take taps through its accessibility service; and its storage is
// browsed through the app's "All files access".
"use strict";

(() => {
const PD = window.PD;
const { h, $ } = PD;

// ── screen shared by the phone app: pane 0 is live; the others hold each recent app's last picture ──
const phone = { sharing: false, w: 0, h: 0, control: false, active: null, apps: [], shots: {}, streams: [], switchTo: null, switchUntil: 0, live: null, ring: [], ringAt: 0 };
let box, status, swapBtn;
PD.share = {
  render(card) {
    swapBtn = h("button", { textContent: "Ask the phone app to share its screen", onclick: () => swap() });
    status = h("span", { className: "dim" });
    const keys = ["back", "home", "recents"].map((k) => h("button", { className: "ic", title: k, innerHTML: PD.icon(k), onclick: () => input({ kind: "key", key: k }) }));
    box = h("div", { className: "sharepanes" });
    card.append(h("h3", { textContent: "Without phone control" }),
      h("p", { className: "dim", textContent: "The PocketDesk app shares the screen once you accept on the phone; taps work when its accessibility service is on." }),
      h("div", { className: "actions" }, swapBtn, ...keys, status), box);
  },
};
function swap() {
  if (phone.sharing) PD.send({ type: "phone_share_end" });
  else { PD.send({ type: "phone_watch" }); say("Asked the phone; its owner has to accept…"); }
}
const say = (t) => { if (status) status.textContent = t; };
const label = () => { if (swapBtn) swapBtn.textContent = phone.sharing ? "Stop the phone app's share" : "Ask the phone app to share its screen"; };
PD.on("phone_state", message);
PD.on("phone_started", message);
PD.on("phone_stopped", message);
PD.on("phone_apps", message);
function message(m) {
  if (m.type === "phone_stopped") {
    phone.sharing = false; phone.active = null; phone.apps = [];
    for (const s of phone.streams) try { s?.decoder?.close(); } catch {}
    phone.streams = [];
    say("The phone stopped sharing.");
  } else if (m.type === "phone_apps") {
    // phone_apps lands after the switch has already reached the video, so the picture is taken from before it.
    const leaving = phone.active?.pkg, now = Date.now();
    const shot = leaving !== m.active?.pkg && phone.ring.findLast((r) => r.pkg === leaving && now - r.t >= 700);
    if (shot) {
      const c = Object.assign(document.createElement("canvas"), { width: shot.b.width, height: shot.b.height });
      c.getContext("2d").drawImage(shot.b, 0, 0);
      phone.shots[leaving] = c.toDataURL("image/jpeg", 0.7);
    }
    phone.active = m.active || null;
    phone.apps = m.apps || [];
    if (phone.switchTo && phone.active?.pkg === phone.switchTo) phone.switchTo = null;
  } else {
    phone.sharing = m.type === "phone_started" || !!m.sharing;
    if (phone.sharing) { phone.w = m.w; phone.h = m.h; phone.control = !!m.control; }
    if ("apps" in m) { phone.active = m.active || null; phone.apps = m.apps || []; }
    say(!phone.sharing ? "" : phone.control ? "" : "View only: PC control is off on the phone.");
  }
  label();
  draw();
}
function draw() {
  if (!box) return;
  const live = stream(0).canvas;
  const typing = document.activeElement;
  box.replaceChildren();
  if (!phone.sharing) return;
  const ratio = phone.w && phone.h ? phone.w / phone.h : 0.5;
  const pane = (text, body, onclick) => {
    const p = h("div", { className: "sharepane" }, h("div", { className: "dim small", textContent: text }), body);
    p.style.aspectRatio = ratio;
    if (onclick) body.onclick = onclick;
    box.append(p);
  };
  pane(phone.active?.label || "Phone", live);
  for (const a of phone.apps.slice(0, 3)) {
    if (a.slot) { pane(a.label || a.pkg, stream(a.slot).canvas); continue; }
    const img = phone.shots[a.pkg] ? h("img", { src: phone.shots[a.pkg] }) : h("div");
    pane(a.label || a.pkg, img, () => { phone.switchTo = a.pkg; phone.switchUntil = Date.now() + 2000; PD.send({ type: "phone_switch", pkg: a.pkg }); });
  }
  if (typing?.tagName === "CANVAS" && typing.isConnected) typing.focus();
}
function input(o) {
  if (!phone.sharing || !phone.control) return;
  if (!o.slot) {
    if (phone.switchTo && Date.now() < phone.switchUntil) return;
    phone.switchTo = null;
  }
  PD.send({ type: "phone_input", ...o });
}
function wire(c, slot) {
  c._wired = true;
  const send = (o) => input(slot ? { ...o, slot } : o);
  const frac = (e) => { const r = c.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }; };
  let down = null;
  c.addEventListener("pointerdown", (e) => { c.focus(); down = { ...frac(e), t: Date.now() }; });
  c.addEventListener("pointerup", (e) => {
    if (!down) return;
    const up = frac(e), ms = Date.now() - down.t;
    const moved = Math.hypot((up.fx - down.fx) * c.width, (up.fy - down.fy) * c.height) > 12;
    if (moved) send({ kind: "swipe", fx: down.fx, fy: down.fy, tx: up.fx, ty: up.fy, ms: Math.max(80, ms) });
    else send({ kind: ms >= 500 ? "press" : "tap", fx: down.fx, fy: down.fy });
    down = null;
  });
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { fx, fy } = frac(e), d = e.deltaY > 0 ? -0.25 : 0.25;
    send({ kind: "swipe", fx, fy, tx: fx, ty: Math.min(1, Math.max(0, fy + d)), ms: 150 });
  }, { passive: false });
  c.addEventListener("keydown", (e) => {
    const key = { Enter: "enter", Backspace: "backspace", Escape: "back" }[e.key];
    if (key) send({ kind: "key", key });
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({ kind: "text", text: e.key });
    else return;
    e.preventDefault();
  });
  c.addEventListener("paste", (e) => { const t = e.clipboardData.getData("text"); if (t) send({ kind: "text", text: t }); e.preventDefault(); });
}
function stream(slot) {
  let st = phone.streams[slot];
  if (!st) {
    const canvas = slot ? h("canvas", { tabIndex: 0 }) : (phone.live ||= h("canvas", { tabIndex: 0 }));
    if (!canvas._wired) wire(canvas, slot);
    st = phone.streams[slot] = { canvas, decoder: null, config: null, needKey: true, ts: 0 };
  }
  return st;
}
/** Phone app video: byte - 16 is slot * 4 + kind, kinds 0-2 being config, keyframe and delta (H.264, Annex B). */
PD.onBinary((buf) => {
  if (buf[0] < 16 || buf[0] > 31) return false;
  const b = buf[0] - 16, slot = b >> 2, kind = b & 3, data = buf.subarray(1);
  const st = stream(slot);
  if (kind === 0) {
    st.config = data;
    const codec = "avc1." + [data[5], data[6], data[7]].map((x) => x.toString(16).padStart(2, "0")).join("");
    try { st.decoder?.close(); } catch {}
    st.needKey = true;
    st.decoder = new VideoDecoder({
      output: (frame) => {
        const c = st.canvas;
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
        c.getContext("2d").drawImage(frame, 0, 0);
        frame.close();
        const now = Date.now(), pkg = phone.active?.pkg;
        if (!slot && pkg && now - phone.ringAt > 300) {
          phone.ringAt = now;
          createImageBitmap(c).then((bm) => { phone.ring.push({ pkg, t: now, b: bm }); if (phone.ring.length > 6) phone.ring.shift().b.close(); });
        }
      },
      error: () => { st.decoder = null; },
    });
    st.decoder.configure({ codec, optimizeForLatency: true });
    return true;
  }
  const d = st.decoder;
  if (!d || d.state !== "configured" || (kind === 2 && st.needKey)) return true;
  let payload = data;
  if (kind === 1) { payload = new Uint8Array(st.config.length + data.length); payload.set(st.config); payload.set(data, st.config.length); }
  st.needKey = false;
  try { d.decode(new EncodedVideoChunk({ type: kind === 1 ? "key" : "delta", timestamp: (st.ts += 33333), data: payload })); } catch { st.needKey = true; }
  return true;
});
PD.on("welcome", () => PD.send({ type: "phone_watch" }));

// ── phone storage, through the phone app ──
const fs = { path: "", rid: 0, waiting: new Map() };
const CHUNK = 256 << 10;
let rows, pathEl, fsStatusEl;
PD.storage = {
  render(el) {
    pathEl = h("span", { className: "mono" });
    fsStatusEl = h("span", { className: "dim" });
    const up = h("input", { type: "file", multiple: true, hidden: true, onchange: () => { upload(up.files); up.value = ""; } });
    rows = h("tbody");
    el.append(h("div", { className: "bar" }, h("button", { textContent: "↑ Up", onclick: () => open(parentOf(fs.path)) }), pathEl, h("span", { className: "gap" }),
      h("button", { textContent: "New folder", onclick: mkdir }), h("button", { textContent: "Upload", onclick: () => up.click() }), up, fsStatusEl),
    h("div", { className: "files" }, h("table", {}, rows)));
  },
  show() { if (!fs.path) open("/"); },
  upload: (files) => upload(files),
};
function call(o) {
  return new Promise((resolve, reject) => {
    const rid = ++fs.rid;
    fs.waiting.set(rid, { resolve, reject });
    PD.send({ type: "phone_fs", rid, ...o });
    setTimeout(() => { if (fs.waiting.delete(rid)) reject(new Error("the phone did not answer")); }, 60000);
  });
}
PD.on("phone_fs_result", (m) => {
  const w = fs.waiting.get(m.rid);
  if (!w) return;
  fs.waiting.delete(m.rid);
  m.error ? w.reject(new Error(m.error)) : w.resolve(m);
});
const join = (dir, name) => (dir.endsWith("/") ? dir : dir + "/") + name;
const parentOf = (p) => p.replace(/\/[^/]*\/?$/, "") || "/";
const human = (n) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`;
const fsSay = (t) => { if (fsStatusEl) fsStatusEl.textContent = t; };
async function open(path) {
  fsSay("loading…");
  try {
    const r = await call({ op: "list", path });
    fs.path = r.path;
    pathEl.textContent = r.path;
    rows.replaceChildren();
    for (const it of r.items) {
      const tr = h("tr", { className: it.dir ? "dir" : "" });
      const cell = (text, cls) => { const td = h("td", { textContent: text, className: cls || "" }); tr.append(td); return td; };
      const name = cell((it.dir ? "📁 " : "") + it.name, "name");
      if (it.dir) name.onclick = () => open(join(fs.path, it.name));
      cell(it.dir ? "" : human(it.size), "dim");
      cell(new Date(it.mtime).toLocaleString(), "dim");
      const actions = cell("");
      const b = (text, fn) => actions.append(h("button", { textContent: text, onclick: fn }), " ");
      if (!it.dir) b("Download", () => download(join(fs.path, it.name), it.name));
      b("Rename", () => rename(it.name));
      b("Delete", () => del(it.name, it.dir));
      rows.append(tr);
    }
    fsSay(`${r.items.length} items`);
  } catch (e) { fsSay(e.message); }
}
async function download(path, name) {
  const parts = [];
  try {
    for (let offset = 0; ; ) {
      const r = await call({ op: "read", path, offset });
      const bin = atob(r.data), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      parts.push(u);
      offset += u.length;
      fsSay(`downloading ${name}: ${Math.floor((offset / (r.size || 1)) * 100)}%`);
      if (r.eof || !u.length) break;
    }
    const a = h("a", { href: URL.createObjectURL(new Blob(parts)), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    fsSay(`downloaded ${name}`);
  } catch (e) { fsSay(`${name}: ${e.message}`); }
}
async function upload(files) {
  const dir = fs.path || "/";
  for (const f of files) {
    try {
      for (let offset = 0; offset < f.size || offset === 0; offset += CHUNK) {
        const bytes = new Uint8Array(await f.slice(offset, offset + CHUNK).arrayBuffer());
        await call({ op: "write", path: join(dir, f.name), data: PD.b64(bytes), append: offset > 0 });
        fsSay(`uploading ${f.name}: ${Math.floor((Math.min(f.size, offset + CHUNK) / (f.size || 1)) * 100)}%`);
        if (!f.size) break;
      }
    } catch (e) { fsSay(`${f.name}: ${e.message}`); return; }
  }
  open(dir);
}
async function mkdir() {
  const name = prompt("New folder name");
  if (!name) return;
  try { await call({ op: "mkdir", path: join(fs.path, name) }); open(fs.path); } catch (e) { fsSay(e.message); }
}
async function rename(name) {
  const to = prompt("New name", name);
  if (!to || to === name) return;
  try { await call({ op: "rename", path: join(fs.path, name), to: join(fs.path, to) }); open(fs.path); } catch (e) { fsSay(e.message); }
}
async function del(name, dir) {
  if (!confirm(`Delete ${dir ? "the folder " : ""}${name} from the phone${dir ? " with everything in it" : ""}?`)) return;
  try { await call({ op: "delete", path: join(fs.path, name) }); open(fs.path); } catch (e) { fsSay(e.message); }
}
})();
