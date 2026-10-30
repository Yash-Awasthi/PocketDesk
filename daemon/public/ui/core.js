// SPDX-License-Identifier: GPL-3.0-or-later
// The page's connection to the daemon, a small event bus, pages and toasts. Every other ui/*.js
// file hangs off window.PD.
"use strict";

(() => {
const PD = (window.PD ||= {});
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
let reconnectTimer, reconnectDelay = 1000, pairCode;
function setUp(up, text) {
  document.body.classList.toggle("online", up);
  PD.$("#loginStatus").textContent = text || (up ? "connected" : "disconnected");
  PD.$("#conn").textContent = up ? "Connected" : "Offline";
  PD.$("#conn").className = up ? "pill ok" : "pill";
}
PD.connect = () => {
  if (PD.ws) { PD.ws.onclose = null; PD.ws.close(); }
  clearTimeout(reconnectTimer);
  const ws = (PD.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    reconnectDelay = 1000;
    PD.send({ type: "hello", token: PD.$("#token").value.trim(), totp: pairCode, name: "PC browser" });
    pairCode = undefined;
  };
  ws.onclose = (ev) => {
    setUp(false);
    PD.emit("offline");
    if (ev.code === 4011) { pairCode = prompt("Two-factor code from your authenticator app") || undefined; if (pairCode) PD.connect(); return; }
    // 4xxx is a refusal (wrong token, locked out, switched off): retrying only burns login attempts.
    if (ev.code >= 4000) {
      if (ev.code === 4003) { try { localStorage.removeItem("pd_token"); } catch {} }
      setUp(false, ev.code === 4029 ? "too many attempts: wait 10 minutes" : ev.reason || `refused (${ev.code})`);
      return;
    }
    reconnectTimer = setTimeout(PD.connect, (reconnectDelay = Math.min(reconnectDelay * 2, 30000)));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      const b = new Uint8Array(ev.data);
      for (const fn of binary) if (fn(b)) return;
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.type === "welcome") {
      if (m.deviceToken) PD.$("#token").value = m.deviceToken;
      try { localStorage.setItem("pd_token", PD.$("#token").value); } catch {}
      setUp(true);
    }
    PD.emit(m.type, m);
  };
};

PD.start = () => {
  PD.buildNav();
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fromLink) history.replaceState(null, "", location.pathname);
  let saved = null, page = null;
  try { saved = localStorage.getItem("pd_token"); page = localStorage.getItem("pd_page"); } catch {}
  const t = fromLink || saved;
  PD.$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") PD.connect(); });
  PD.go(page || "home");
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
})();
