// SPDX-License-Identifier: GPL-3.0-or-later
// The page's connection to the daemon, a small event bus, pages and toasts. Every other ui/*.js
// file imports this module, which owns the shared state and helpers.

const PD = {};
const handlers = new Map();
const binary = [];
PD.on = (type, fn) => { (handlers.get(type) || handlers.set(type, []).get(type)).push(fn); };
PD.emit = (type, m) => { for (const fn of handlers.get(type) || []) try { fn(m); } catch (e) { console.error(type, e); } };
PD.onBinary = (fn) => binary.push(fn);
PD.send = (o) => { if (PD.ws && PD.ws.readyState === 1) PD.ws.send(JSON.stringify(o)); };
PD.b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
PD.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
PD.$ = (sel, root = document) => root.querySelector(sel);
PD.h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};

// ── list state: loading, empty, error, and one retry that survives a re-render ──
// The click listener is on the container, never on the note or the button: a state paint replaces
// those children, and a listener attached to a replaced node dies with it.
const STATE = { loading: "Loading…", error: "Could not load this." };
const boxes = new WeakMap();
PD.up = () => PD.connState === "up";
PD.stateBox = (el, opts = {}) => {
  let box = boxes.get(el);
  if (!box) {
    el.addEventListener("click", (e) => {
      const hit = e.target.closest?.('[data-action="retry"]');
      if (!hit || !el.contains(hit) || !PD.up()) return;
      boxes.get(el).opts.retry?.();
    });
    box = { el, opts: {} };
    boxes.set(el, box);
    PD.on("conn", () => {
      const hit = el.querySelector('[data-action="retry"]');
      if (hit) hit.disabled = !PD.up();
    });
    box.show = (state, detail) => {
      if (!state) return void delete el.dataset.state;
      el.dataset.state = state;
      const text =
        state === "empty"
          ? box.opts.empty
          : state === "error"
            ? `${STATE.error}${detail ? ` ${detail}` : ""}`
            : STATE.loading;
      const kids = [PD.h("div", { className: "empty", textContent: text, role: state === "error" ? "alert" : "status" })];
      if (state !== "loading") {
        // `dataset` is a read-only accessor, so the attribute goes on after the element exists.
        const again = PD.h("button", { textContent: "Retry", disabled: !PD.up() });
        again.dataset.action = "retry";
        kids.push(again);
      }
      el.replaceChildren(...kids);
    };
    box.clear = () => { delete el.dataset.state; };
  }
  Object.assign(box.opts, opts);
  return box;
};

PD.toast = (text, bad) => {
  const box = PD.$("#toasts");
  const t = PD.h("div", { className: `toast${bad ? " bad" : ""}`, textContent: text });
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.classList.add("gone"), 3500);
  setTimeout(() => t.remove(), 4000);
};

// ── pages ──
const pages = new Map();
PD.page = (id, { title, icon, render, show }) => pages.set(id, { title, icon, render, show });
PD.go = (id) => {
  if (!pages.has(id)) id = "home";
  PD.current = id;
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", a.dataset.page === id);
  for (const s of document.querySelectorAll(".page")) s.hidden = s.id !== `page-${id}`;
  PD.$("#pageTitle").textContent = pages.get(id).title;
  try { localStorage.setItem("pd_page", id); } catch {}
  pages.get(id).show?.(PD.$(`#page-${id}`));
};
/** A count beside a page's name in the sidebar; 0 hides it. */
PD.badge = (id, n) => {
  const a = document.querySelector(`#nav a[data-page="${id}"]`);
  if (!a) return;
  let b = a.querySelector(".badge-n");
  if (!b) a.append((b = PD.h("span", { className: "badge-n" })));
  b.textContent = n > 99 ? "99+" : String(n);
  b.hidden = !n;
};
PD.buildNav = () => {
  const nav = PD.$("#nav"), main = PD.$("#pages");
  for (const [id, p] of pages) {
    nav.append(PD.h("a", { href: `#${id}`, className: "navlink", innerHTML: `<span class="ni">${p.icon}</span><span>${PD.esc(p.title)}</span>`, onclick: (e) => { e.preventDefault(); PD.go(id); } }));
    nav.lastChild.dataset.page = id;
    const sec = PD.h("section", { className: "page", id: `page-${id}`, hidden: true });
    main.append(sec);
    p.render?.(sec);
  }
};

// ── connection: the token comes from #t= in the link, this browser's last login, or the box ──
const CONN = { up: "Connected", retry: "Reconnecting...", down: "Offline" };
// A version refusal is permanent: name both numbers, keep #conn's vocabulary, never schedule a retry.
const mismatchText = (m) =>
  `protocol mismatch: this page sends ${m.found}, the daemon expects ${m.expected}. Reload after updating PocketDesk.`;
// body.online follows live, not each socket: it stays on through a scheduled retry so the shell and
// the indicator do not vanish on a blip, and drops only when no retry is scheduled.
let reconnectTimer, reconnectDelay = 1000, pairCode, live = false;
function setConn(state, note) {
  PD.connState = state;
  if (state === "up") live = true;
  if (state === "down") live = false;
  const pill = PD.$("#conn");
  pill.textContent = CONN[state];
  pill.dataset.state = state;
  pill.classList.toggle("ok", state === "up");
  pill.classList.toggle("wait", state === "retry");
  const slot = live ? PD.$("#connSlot") : PD.$("#login .conn-row");
  if (pill.parentElement !== slot) slot.append(pill);
  const reason = PD.$("#loginStatus");
  reason.textContent = note || "";
  reason.hidden = !note;
  document.body.classList.toggle("online", live);
  PD.emit("conn", state);
}
PD.connect = () => {
  if (PD.ws) { PD.ws.onclose = null; PD.ws.close(); }
  clearTimeout(reconnectTimer);
  const ws = (PD.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    reconnectDelay = 1000;
    const hello = { type: "hello", token: PD.$("#token").value.trim(), totp: pairCode, name: "PC browser" };
    // The version comes from the served page's pd-protocol meta, itself written from compat.json.
    if (Number.isInteger(PD.protocolVersion)) hello.protocolVersion = PD.protocolVersion;
    PD.send(hello);
    pairCode = undefined;
  };
  ws.onclose = (ev) => {
    PD.emit("offline");
    if (ev.code === 4011) {
      pairCode = prompt("Two-factor code from your authenticator app") || undefined;
      if (pairCode) { setConn("retry"); PD.connect(); } else setConn("down");
      return;
    }
    // A version refusal is permanent and names both numbers; anything else 4xxx is a refusal too.
    if (ev.code === 4026) {
      setConn("down", PD.mismatch ? mismatchText(PD.mismatch) : "protocol version mismatch");
      return;
    }
    // 4xxx is a refusal (wrong token, locked out, switched off): retrying only burns login attempts.
    if (ev.code >= 4000) {
      if (ev.code === 4003) { try { localStorage.removeItem("pd_token"); } catch {} }
      setConn("down", ev.code === 4029 ? "too many attempts: wait 10 minutes" : ev.reason || `refused (${ev.code})`);
      return;
    }
    setConn("retry");
    reconnectTimer = setTimeout(PD.connect, (reconnectDelay = Math.min(reconnectDelay * 2, 30000)));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      const b = new Uint8Array(ev.data);
      for (const fn of binary) if (fn(b)) return;
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.type === "protocol_mismatch") {
      PD.mismatch = { expected: m.expected, found: m.found };
      setConn("down", mismatchText(PD.mismatch));
    }
    if (m.type === "welcome") {
      PD.os = m.os;
      if (m.deviceToken) PD.$("#token").value = m.deviceToken;
      try { localStorage.setItem("pd_token", PD.$("#token").value); } catch {}
      setConn("up");
      // PD.start() shows the first page before the socket opens, so its show() asked for data nobody
      // heard. Ask again now that the welcome arrived; otherwise Home stays empty until a page switch.
      pages.get(PD.current)?.show?.(PD.$(`#page-${PD.current}`));
      PD.emit("page_refresh", PD.current);
    }
    PD.emit(m.type, m);
  };
};

PD.start = () => {
  // This PC's own page carries its token and pairing codes (server.js adds them only to loopback
  // responses), so opening PocketDesk on the PC is already signed in; phones on the LAN get the
  // plain page. Read before buildNav, which renders the pages that use them.
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";
  PD.protocolVersion = Number(meta("pd-protocol")) || null;
  PD.localToken = meta("pd-token");
  PD.pairPayload = meta("pd-qr");
  PD.hubUrl = meta("pd-hub");
  PD.fingerprint = meta("pd-fp");
  // One frontend: pairing, security and this install are a page of the hub, on the PC only.
  if (PD.localToken) PD.registerThisPc?.();
  PD.buildNav();
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromLink = hash.get("t");
  // An app shortcut (installed page) opens straight on its page.
  const goTo = hash.get("go");
  if (fromLink || goTo) history.replaceState(null, "", location.pathname);
  let saved = null, page = null;
  try { saved = localStorage.getItem("pd_token"); page = localStorage.getItem("pd_page"); } catch {}
  const t = fromLink || PD.localToken || saved;
  PD.$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") PD.connect(); });
  PD.go(goTo || page || "home");
  if (t) { PD.$("#token").value = t; PD.connect(); }
  // Theme: system by default; the toggle cycles light, dark and system.
  const apply = (m) => { if (m) document.documentElement.dataset.theme = m; else delete document.documentElement.dataset.theme; };
  let theme = null;
  try { theme = localStorage.getItem("pd_theme"); } catch {}
  apply(theme);
  PD.$("#themeBtn").onclick = () => {
    theme = theme === "light" ? "dark" : theme === "dark" ? null : "light";
    apply(theme);
    try { theme ? localStorage.setItem("pd_theme", theme) : localStorage.removeItem("pd_theme"); } catch {}
  };
};

export { PD };
