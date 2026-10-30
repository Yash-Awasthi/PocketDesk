// SPDX-License-Identifier: GPL-3.0-or-later
// The pages of the PC's phone hub.
"use strict";

(() => {
const PD = window.PD;
const { h, esc, $ } = PD;
const I = {
  home: '<svg viewBox="0 0 20 20"><path d="M3.5 9 10 3.5 16.5 9v7.5h-4.5v-5h-4v5H3.5z"/></svg>',
  screen: '<svg viewBox="0 0 20 20"><rect x="6" y="2.5" width="8" height="15" rx="1.8"/><path d="M9 15h2"/></svg>',
  apps: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="5" height="5" rx="1"/><rect x="11.5" y="3.5" width="5" height="5" rx="1"/><rect x="3.5" y="11.5" width="5" height="5" rx="1"/><rect x="11.5" y="11.5" width="5" height="5" rx="1"/></svg>',
  camera: '<svg viewBox="0 0 20 20"><path d="M3 6.5h3l1.5-2h5L14 6.5h3v9H3z"/><circle cx="10" cy="11" r="2.8"/></svg>',
  messages: '<svg viewBox="0 0 20 20"><path d="M3.5 4.5h13v9h-8l-3.5 3v-3H3.5z"/></svg>',
  calls: '<svg viewBox="0 0 20 20"><path d="M5 3.5h3l1.5 4-2 1.2a8 8 0 0 0 3.8 3.8l1.2-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A13 13 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/></svg>',
  notifications: '<svg viewBox="0 0 20 20"><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0"/></svg>',
  photos: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="m3.5 14 4-4 3 3 2-2 4 4"/><circle cx="13" cy="7.5" r="1.3"/></svg>',
  files: '<svg viewBox="0 0 20 20"><path d="M3 5.5V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1H9.5L8 4.5H4a1 1 0 0 0-1 1z"/></svg>',
  clipboard: '<svg viewBox="0 0 20 20"><rect x="5" y="4" width="10" height="13" rx="1.5"/><path d="M8 4V3h4v1"/><path d="M7.5 8.5h5 M7.5 11.5h5 M7.5 14.5h3"/></svg>',
  connect: '<svg viewBox="0 0 20 20"><path d="M8 12l4-4 M6.5 9.5 5 11a2.8 2.8 0 0 0 4 4l1.5-1.5 M13.5 10.5 15 9a2.8 2.8 0 0 0-4-4L9.5 6.5"/></svg>',
};
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });
const rel = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString();
};
const img = (b64, type = "image/png") => (b64 ? `data:${type};base64,${b64}` : "");
const empty = (text) => h("div", { className: "empty", textContent: text });
const needApp = () => empty("Open the PocketDesk app on the phone and connect it to this PC; its notifications, texts, calls and photos come through it.");
const run = async (fn, okText) => { try { const r = await fn(); if (okText) PD.toast(okText); return r; } catch (e) { PD.toast(e.message, true); } };
const phoneReady = () => !!PD.adb.state?.serial;

// ── Home ──
PD.page("home", {
  title: "Home", icon: I.home,
  render(sec) {
    sec.append(
      h("div", { className: "grid2" },
        h("div", { className: "card", id: "homePhone" }),
        h("div", { className: "card", id: "homeMedia" })),
      h("div", { className: "card", id: "homeToggles" }),
      h("div", { className: "card", id: "homeNotifs" }));
    const draw = () => { drawPhoneCard(); drawMedia(); drawToggles(); drawHomeNotifs(); };
    PD.on("adb_changed", draw);
    PD.on("hub_changed", draw);
  },
  show() { PD.send({ type: "adb_state" }); PD.send({ type: "phone_hub" }); },
});
function drawPhoneCard() {
  const box = $("#homePhone");
  const a = PD.adb.state, hub = PD.hub, bat = hub.state.battery;
  const name = a?.model || hub.name || "Your phone";
  box.replaceChildren(
    h("div", { className: "row" }, h("div", { className: "phone-ico", innerHTML: I.screen }),
      h("div", { className: "grow" }, h("div", { className: "big", textContent: name }),
        h("div", { className: "dim", textContent: [a?.serial ? `Control: ${a.via === "usb" ? "USB cable" : "wireless debugging"}` : "Control: not set up", hub.online ? "App: connected" : "App: offline", bat ? `Battery ${bat.level}%${bat.charging ? " charging" : ""}` : ""].filter(Boolean).join(" · ") }))),
    h("div", { className: "actions" },
      a?.serial ? [btn("Show screen", () => PD.adb.open("screen"), "primary"), btn("Apps", () => PD.go("apps")), btn("Camera", () => PD.go("camera"))]
        : btn("Set up phone control", () => PD.go("connect"), "primary"),
      hub.online && btn("Find my phone", () => run(() => PD.ask("find", "ring"), "Ringing the phone"))));
}
function drawMedia() {
  const box = $("#homeMedia"), m = PD.hub.state.media;
  if (!m || !m.title) return box.replaceChildren(h("div", { className: "dim", textContent: "Nothing playing on the phone." }));
  const ctl = (op, label) => btn(label, () => run(() => PD.ask("media", op)));
  box.replaceChildren(
    h("div", { className: "row" },
      m.art ? h("img", { className: "art", src: img(m.art, "image/jpeg"), alt: "" }) : h("div", { className: "art" }),
      h("div", { className: "grow" }, h("div", { className: "big", textContent: m.title }), h("div", { className: "dim", textContent: [m.artist, m.app].filter(Boolean).join(" · ") }))),
    h("div", { className: "actions" }, ctl("prev", "⏮"), ctl(m.playing ? "pause" : "play", m.playing ? "⏸" : "▶"), ctl("next", "⏭")));
}
function drawToggles() {
  const box = $("#homeToggles"), t = PD.hub.state.toggles;
  const items = [];
  const tog = (id, label, on, set) => items.push(h("button", { className: `tog${on ? " on" : ""}`, textContent: label, onclick: set }));
  const adb = (on, off, cur) => () => run(() => new Promise((res) => { PD.send({ type: "adb_action", action: cur ? off : on }); setTimeout(res, 300); }));
  if (t) {
    tog("wifi", "Wi-Fi", t.wifi, () => (phoneReady() ? adb("wifi_on", "wifi_off", t.wifi)() : run(() => PD.ask("toggles", "set", { id: "wifi", on: !t.wifi }))));
    tog("bluetooth", "Bluetooth", t.bluetooth, () => (phoneReady() ? adb("bt_on", "bt_off", t.bluetooth)() : run(() => PD.ask("toggles", "set", { id: "bluetooth", on: !t.bluetooth }))));
    tog("dnd", "Do not disturb", t.dnd, () => run(() => PD.ask("toggles", "set", { id: "dnd", on: !t.dnd })));
    if (t.flashlight != null) tog("flashlight", "Flashlight", t.flashlight, () => run(() => PD.ask("toggles", "set", { id: "flashlight", on: !t.flashlight })));
    for (const mode of ["ring", "vibrate", "silent"]) tog(`ringer-${mode}`, mode[0].toUpperCase() + mode.slice(1), t.ringer === mode, () => run(() => PD.ask("toggles", "set", { id: "ringer", mode })));
  } else if (phoneReady()) {
    tog("wifi", "Wi-Fi on", false, adb("wifi_on", "wifi_off", false));
    tog("wifi", "Wi-Fi off", false, adb("wifi_off", "wifi_on", false));
    tog("bt", "Bluetooth on", false, adb("bt_on", "bt_off", false));
    tog("bt", "Bluetooth off", false, adb("bt_off", "bt_on", false));
    tog("dnd", "Do not disturb", false, adb("dnd_on", "dnd_off", false));
  }
  const slider = (label, value, set) => h("label", { className: "slider" }, h("span", { textContent: label }),
    h("input", { type: "range", min: 0, max: 100, value: value ?? 50, onchange: (e) => set(Number(e.target.value)) }));
  box.replaceChildren(h("h3", { textContent: "Quick settings" }), items.length ? h("div", { className: "toggles" }, items) : empty("Connect the phone app or set up phone control to change its settings from here."),
    t ? h("div", { className: "sliders" },
      slider("Volume", t.volume, (v) => run(() => PD.ask("toggles", "set", { id: "volume", level: v }))),
      slider("Brightness", t.brightness, (v) => run(() => PD.ask("toggles", "set", { id: "brightness", level: v })))) : "");
}
function drawHomeNotifs() {
  const box = $("#homeNotifs"), list = PD.notifs.list.slice(0, 5);
  box.replaceChildren(h("h3", {}, "Notifications ", h("a", { href: "#", textContent: "all", onclick: (e) => { e.preventDefault(); PD.go("notifications"); } })),
    list.length ? list.map(notifRow) : empty(PD.hub.online ? "No notifications." : "Notifications come from the PocketDesk app on the phone."));
}

// ── Phone screen ──
PD.page("screen", {
  title: "Phone screen", icon: I.screen,
  render(sec) {
    const s = PD.adb.settings;
    const sel = (key, opts) => h("select", { onchange: (e) => { s[key] = isNaN(+e.target.value) ? e.target.value : +e.target.value; PD.adb.saveSettings(); } },
      opts.map(([v, l]) => h("option", { value: v, textContent: l, selected: String(s[key]) === String(v) })));
    const check = (key, label) => h("label", { className: "check" }, h("input", { type: "checkbox", checked: !!s[key], onchange: (e) => { s[key] = e.target.checked; PD.adb.saveSettings(); } }), label);
    const typeBox = h("textarea", { rows: 2, placeholder: "Type here and press Enter to type it on the phone. Keys you press here go to the phone too." });
    typeBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (typeBox.value) PD.send({ type: "adb_type", text: typeBox.value });
        else PD.send({ type: "adb_type", code: "Enter", down: true }), PD.send({ type: "adb_type", code: "Enter", down: false });
        typeBox.value = "";
      } else if (!typeBox.value && ["Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.key)) {
        e.preventDefault();
        PD.send({ type: "adb_type", code: e.code, down: true });
        PD.send({ type: "adb_type", code: e.code, down: false });
      }
    });
    sec.append(
      h("div", { className: "card" },
        h("h3", { textContent: "Your phone in a window" }),
        h("p", { className: "dim", textContent: "Click to tap, drag to swipe, right click for Back, middle click for Home, the wheel scrolls, Ctrl+wheel pinches, the keyboard types. Drop files on the window to send them to the phone." }),
        h("div", { className: "actions" },
          btn("Show phone screen", () => (phoneReady() ? PD.adb.open("screen") : PD.go("connect")), "primary"),
          btn("Phone sound only", () => PD.adb.open("sound")),
          btn("Phone microphone", () => PD.adb.open("mic")),
          btn("Screenshot", () => PD.send({ type: "adb_screenshot" }))),
        h("div", { className: "form" },
          h("label", {}, "Picture ", sel("codec", [["h264", "H.264"], ["h265", "H.265 (sharper, needs hardware support)"]])),
          h("label", {}, "Quality ", sel("mbps", [[4, "4 Mbit/s"], [8, "8 Mbit/s"], [16, "16 Mbit/s"], [24, "24 Mbit/s"]])),
          h("label", {}, "Frame rate ", sel("fps", [[30, "30"], [60, "60"], [90, "90"], [120, "120"]])),
          h("label", {}, "Size ", sel("maxSize", [[0, "Full"], [1920, "1920"], [1600, "1600"], [1280, "1280"], [1024, "1024"]])),
          check("audio", "Phone sound (Android 11 and later)"),
          check("enterSends", "Enter sends in WhatsApp, Telegram and Signal"))),
      h("div", { className: "card" }, h("h3", { textContent: "Type on the phone" }), typeBox),
      PD.padCard(),
      h("div", { className: "card", id: "legacyShare" }));
    PD.share?.render($("#legacyShare"));
  },
});

// ── Apps ──
PD.page("apps", {
  title: "Apps", icon: I.apps,
  render(sec) {
    const q = h("input", { type: "search", placeholder: "Search apps", oninput: () => draw() });
    const sys = h("input", { type: "checkbox" });
    sys.onchange = () => draw();
    const grid = h("div", { className: "appgrid" });
    sec.append(h("div", { className: "bar" }, q, h("label", { className: "check" }, sys, "Only apps I installed"), btn("Refresh", () => PD.send({ type: "adb_apps", refresh: true }))),
      h("p", { className: "dim", textContent: "Each app opens in a window of its own, on a display of its own beside what the phone shows. Resize the window and the app follows." }), grid);
    const draw = () => {
      if (!phoneReady()) return grid.replaceChildren(empty("Set up phone control on the Connect page first."), btn("Connect", () => PD.go("connect"), "primary"));
      const f = q.value.trim().toLowerCase();
      const apps = PD.adb.apps.filter((a) => (!sys.checked || !a.system) && (!f || a.label.toLowerCase().includes(f) || a.pkg.includes(f)));
      grid.replaceChildren(...apps.map((a) => h("button", { className: "app", title: a.pkg, onclick: () => PD.adb.open("app", { pkg: a.pkg, label: a.label }) },
        PD.adb.icons?.[a.pkg] ? h("img", { className: "app-ico", src: img(PD.adb.icons[a.pkg]), alt: "" })
          : h("span", { className: "app-ico", textContent: a.label.slice(0, 1).toUpperCase(), style: `background:hsl(${[...a.pkg].reduce((x, c) => x + c.charCodeAt(0), 0) % 360} 55% 45%)` }),
        h("span", { className: "app-name", textContent: a.label }))));
      if (!apps.length) grid.append(empty(PD.adb.apps.length ? "No app matches." : "Loading the phone's apps…"));
    };
    PD.on("adb_apps_changed", () => {
      draw();
      // Real icons come from the phone app when it is connected; letters stand in until then.
      if (PD.hub.online && PD.adb.apps.length && !PD.adb.icons) {
        PD.adb.icons = {};
        PD.ask("apps", "icons", { pkgs: PD.adb.apps.map((a) => a.pkg) }, 60000).then((r) => { PD.adb.icons = r.icons || {}; draw(); }).catch(() => { PD.adb.icons = null; });
      }
    });
    PD.on("adb_changed", () => { if (PD.current === "apps" && phoneReady() && !PD.adb.apps.length) PD.send({ type: "adb_apps" }); draw(); });
    this.draw = draw;
  },
  show() { if (phoneReady() && !PD.adb.apps.length) PD.send({ type: "adb_apps" }); this.draw?.(); },
});

// ── Camera ──
PD.page("camera", {
  title: "Camera", icon: I.camera,
  render(sec) {
    const facing = h("select", {}, h("option", { value: "back", textContent: "Back camera" }), h("option", { value: "front", textContent: "Front camera" }));
    const size = h("select", {}, h("option", { value: "", textContent: "Best size" }));
    PD.on("adb_cameras", (m) => {
      size.replaceChildren(h("option", { value: "", textContent: "Best size" }));
      const cam = m.cameras.find((c) => c.facing === facing.value);
      for (const s of cam?.sizes || []) size.append(h("option", { value: s, textContent: s }));
    });
    facing.onchange = () => PD.send({ type: "adb_cameras" });
    sec.append(h("div", { className: "card" },
      h("h3", { textContent: "The phone's camera on this PC" }),
      h("p", { className: "dim", textContent: "Shows the camera in a window you can pop out over a video call, screenshot or record. Light and zoom are in its bar. Android 12 or later." }),
      h("div", { className: "actions" }, facing, size, btn("Open camera", () => (phoneReady() ? PD.adb.open("camera", { facing: facing.value, size: size.value }) : PD.go("connect")), "primary"))),
      h("div", { className: "card", id: "webcamCard" }));
    const draw = (st) => {
      const box = $("#webcamCard");
      const on = st?.state === "on" || st?.state === "starting";
      box.replaceChildren(h("h3", { textContent: "Use it as this PC's webcam" }),
        h("p", { className: "dim", textContent: "Zoom, Teams, Meet, OBS and the Camera app see \"PocketDesk Webcam\". Windows 11 only." }),
        !st ? h("div", { className: "dim", textContent: "Checking…" })
          : !st.supported ? h("div", { className: "bad", textContent: st.reason })
          : !st.registered ? h("div", { className: "actions" }, btn("Set up the webcam (asks for administrator rights once)", () => PD.send({ type: "adb_webcam_register" }), "primary"))
          : h("div", { className: "actions" },
            btn(on ? `Stop (${st.facing} camera ${st.state === "on" ? "live" : "starting"})` : "Start the webcam", () => PD.send({ type: "adb_webcam", on: !on, facing: facing.value, size: size.value }), on ? "danger" : "primary"),
            st.error ? h("span", { className: "bad", textContent: st.error }) : ""));
    };
    PD.on("adb_webcam", draw);
    draw(null);
  },
  show() { if (phoneReady()) PD.send({ type: "adb_cameras" }); PD.send({ type: "adb_webcam_status" }); },
});

// ── Messages ──
PD.sms = { threads: [], open: null };
PD.page("messages", {
  title: "Messages", icon: I.messages,
  render(sec) {
    sec.classList.add("split");
    const list = h("div", { className: "list", id: "smsList" });
    const conv = h("div", { className: "conv", id: "smsConv" });
    sec.append(h("div", { className: "col" }, h("div", { className: "bar" }, btn("New message", () => openThread(null), "primary"), btn("Refresh", () => loadThreads())), list), conv);
    PD.on("evt_sms", (e) => { loadThreads(); if (PD.sms.open && e.thread === PD.sms.open.id) openThread(PD.sms.open); });
  },
  show() { loadThreads(); },
});
async function loadThreads() {
  const list = $("#smsList");
  if (!PD.hub.online) return list.replaceChildren(needApp());
  const r = await run(() => PD.ask("sms", "threads"));
  if (!r) return;
  PD.sms.threads = r.threads || [];
  list.replaceChildren(...PD.sms.threads.map((t) => h("button", { className: `item${PD.sms.open?.id === t.id ? " on" : ""}`, onclick: () => openThread(t) },
    h("div", { className: "row" }, h("b", { className: "grow", textContent: t.name || t.address }), h("span", { className: "dim", textContent: rel(t.date) })),
    h("div", { className: `dim clip${t.unread ? " unread" : ""}`, textContent: t.snippet || "" }))));
  if (!PD.sms.threads.length) list.append(empty(r.error || "No conversations, or the app has no permission to read texts yet."));
}
async function openThread(t) {
  PD.sms.open = t;
  const conv = $("#smsConv");
  const to = h("input", { placeholder: "Phone number", value: t?.address || "" });
  const box = h("div", { className: "bubbles" });
  const text = h("textarea", { rows: 2, placeholder: "Text message" });
  let picture = null;
  const chip = h("span", { className: "dim small" });
  const file = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => { picture = file.files[0] ? await shrink(file.files[0]) : null; chip.textContent = picture ? `Picture: ${file.files[0].name}` : ""; file.value = ""; } });
  const sendIt = async () => {
    if ((!text.value.trim() && !picture) || !to.value.trim()) return;
    const body = text.value, image = picture;
    text.value = ""; picture = null; chip.textContent = "";
    if (await run(() => PD.ask("sms", "send", { address: to.value.trim(), text: body, ...(image ? { image, mime: "image/jpeg" } : {}) }, 60000), "Sent")) setTimeout(() => (t ? openThread(t) : loadThreads()), 1200);
  };
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  conv.replaceChildren(h("div", { className: "bar" }, t ? h("b", { textContent: t.name || t.address }) : to, t ? h("span", { className: "dim", textContent: t.address }) : ""), box,
    h("div", { className: "composer" }, btn("Picture", () => file.click()), file, h("div", { className: "grow" }, text, chip), btn("Send", sendIt, "primary")));
  for (const b of document.querySelectorAll("#smsList .item")) b.classList.remove("on");
  if (!t) return to.focus();
  const r = await run(() => PD.ask("sms", "messages", { thread: t.id }));
  box.replaceChildren(...(r?.messages || []).map((m) => h("div", { className: `bubble${m.out ? " out" : ""}` },
    m.image ? h("img", { src: img(m.image, "image/jpeg"), alt: "" }) : "", h("div", { textContent: m.text || "" }), h("div", { className: "dim small", textContent: new Date(m.date).toLocaleString() }))));
  box.scrollTop = box.scrollHeight;
  text.focus();
}

/** A picture small enough for MMS (carriers cap it near 300 KB), as base64 JPEG. */
async function shrink(f) {
  const bmp = await createImageBitmap(f);
  for (const side of [1600, 1200, 900, 640]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = h("canvas", { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    if (blob.size <= 290_000 || side === 640) return PD.b64(new Uint8Array(await blob.arrayBuffer()));
  }
}
PD.newText = (n) => { openThread(null); setTimeout(() => { const i = $("#smsConv input"); if (i) i.value = n; }, 0); };

// ── Calls ──
PD.page("calls", {
  title: "Calls", icon: I.calls,
  render(sec) {
    sec.classList.add("split");
    const num = h("input", { className: "dialnum", placeholder: "Number" });
    const pad = h("div", { className: "dialpad" }, [..."123456789*0#"].map((d) => btn(d, () => { num.value += d; })));
    const contacts = h("div", { className: "list", id: "contactList" });
    const q = h("input", { type: "search", placeholder: "Search contacts", oninput: () => searchContacts(q.value, contacts, num) });
    sec.append(h("div", { className: "col" }, h("div", { className: "card" }, num, pad, h("div", { className: "actions" }, btn("Call", () => num.value && run(() => PD.ask("calls", "dial", { number: num.value }), "Calling on the phone"), "primary"), btn("⌫", () => { num.value = num.value.slice(0, -1); }))), q, contacts),
      h("div", { className: "col" }, h("div", { className: "bar" }, h("b", { textContent: "Recent calls" }), btn("Refresh", () => loadCalls())), h("div", { className: "list", id: "callLog" })));
  },
  show() { loadCalls(); },
});
async function loadCalls() {
  const box = $("#callLog");
  if (!PD.hub.online) return box.replaceChildren(needApp());
  const r = await run(() => PD.ask("calls", "log"));
  const kinds = { 1: "↙ incoming", 2: "↗ outgoing", 3: "✕ missed", 5: "rejected", 6: "blocked" };
  box.replaceChildren(...(r?.calls || []).map((c) => h("div", { className: "item row" },
    h("div", { className: "grow" }, h("b", { textContent: c.name || c.number }), h("div", { className: `dim${c.kind === 3 ? " bad" : ""}`, textContent: `${kinds[c.kind] || ""} · ${rel(c.date)}${c.duration ? ` · ${Math.round(c.duration / 60)} min` : ""}` })),
    btn("Call", () => run(() => PD.ask("calls", "dial", { number: c.number }), "Calling on the phone")))));
  if (!r?.calls?.length) box.append(empty("No calls, or the app has no permission to read the call log yet."));
}
let contactTimer;
function searchContacts(q, box, num) {
  clearTimeout(contactTimer);
  contactTimer = setTimeout(async () => {
    const r = await run(() => PD.ask("contacts", "search", { q }));
    box.replaceChildren(...(r?.contacts || []).map((c) => h("div", { className: "item" }, h("b", { textContent: c.name }),
      ...c.numbers.map((n) => h("div", { className: "row" }, h("span", { className: "grow dim", textContent: n }), btn("Call", () => run(() => PD.ask("calls", "dial", { number: n }), "Calling")), btn("Text", () => { PD.go("messages"); openThread({ id: null, address: n, name: c.name }); }))))));
  }, 250);
}
// A ringing phone shows on every page, with Answer and Decline.
PD.on("evt_call", (e) => {
  const box = $("#callPop");
  if (e.state !== "ringing" && e.state !== "active") { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(h("div", { className: "big", textContent: e.name || e.number || "Unknown caller" }), h("div", { className: "dim", textContent: e.state === "ringing" ? "Incoming call" : "On a call" }),
    h("div", { className: "actions" },
      e.state === "ringing" && btn("Answer", () => run(() => PD.ask("calls", "answer")), "primary"),
      btn(e.state === "ringing" ? "Decline" : "Hang up", () => run(() => PD.ask("calls", "end")), "danger"),
      e.state === "ringing" && btn("Silence", () => run(() => PD.ask("calls", "silence")))));
  if (e.state === "ringing" && !PD.sync?.phoneToasts && Notification?.permission === "granted") new Notification(`Call from ${e.name || e.number}`, { tag: "pd-call" });
});

// ── Notifications ──
PD.notifs = { list: [] };
function notifRow(n) {
  const reply = h("input", { placeholder: "Reply", hidden: true });
  reply.addEventListener("keydown", (e) => { if (e.key === "Enter" && reply.value) { run(() => PD.ask("notif", "reply", { key: n.key, action: reply.dataset.action, text: reply.value }), "Replied"); reply.value = ""; reply.hidden = true; } });
  return h("div", { className: "notif" },
    n.icon ? h("img", { className: "nicon", src: img(n.icon), alt: "" }) : h("div", { className: "nicon" }),
    h("div", { className: "grow" },
      h("div", { className: "row" }, h("b", { className: "grow", textContent: n.title || n.appName }), h("span", { className: "dim small", textContent: `${n.appName} · ${rel(n.when)}` })),
      h("div", { className: "ntext", textContent: n.text || "" }),
      n.image ? h("img", { className: "nimg", src: img(n.image, "image/jpeg"), alt: "" }) : "",
      n.progress != null ? h("progress", { max: n.max || 100, value: n.progress }) : "",
      h("div", { className: "actions" },
        (n.code ? [btn(`Copy ${n.code}`, () => navigator.clipboard.writeText(n.code).then(() => PD.toast("Code copied")))] : []),
        (n.actions || []).map((a) => btn(a.title, () => { if (a.reply) { reply.hidden = false; reply.dataset.action = a.id; reply.focus(); } else run(() => PD.ask("notif", "action", { key: n.key, action: a.id })); })),
        btn("Dismiss", () => run(() => PD.ask("notif", "dismiss", { key: n.key }))),
        btn(`Mute ${n.appName}`, () => { PD.send({ type: "phone_sync_set", muted: [...new Set([...(PD.sync.muted || []), n.app])] }); PD.toast(`${n.appName} no longer pops up on this PC`); }),
        phoneReady() && btn("Open", () => PD.adb.open("app", { pkg: n.app, label: n.appName }))),
      reply));
}
PD.page("notifications", {
  title: "Notifications", icon: I.notifications,
  render(sec) {
    const box = h("div", { id: "notifList" });
    sec.append(h("div", { className: "bar" }, btn("Clear all", () => run(() => PD.ask("notif", "dismiss_all"))), btn("Refresh", () => loadNotifs()),
      "Notification" in window && Notification.permission === "default" ? btn("Show as desktop notifications", () => Notification.requestPermission()) : ""), PD.syncCard("pcnotif"), box);
    const draw = () => {
      box.replaceChildren(...PD.notifs.list.map(notifRow));
      if (!PD.notifs.list.length) box.append(PD.hub.online ? empty("No notifications on the phone.") : needApp());
      drawHomeNotifs();
    };
    PD.on("notifs_changed", draw);
  },
  show() { loadNotifs(); },
});
async function loadNotifs() {
  const r = await PD.ask("notif", "list").catch(() => null);
  if (r) { PD.notifs.list = r.items || []; PD.emit("notifs_changed"); }
}
PD.on("evt_notif", (e) => {
  if (e.op === "posted") {
    const i = PD.notifs.list.findIndex((n) => n.key === e.item.key);
    if (i >= 0) PD.notifs.list[i] = e.item; else PD.notifs.list.unshift(e.item);
    if (!e.item.silent && document.hidden && !PD.sync?.phoneToasts && Notification?.permission === "granted") new Notification(e.item.title || e.item.appName, { body: e.item.text || "", tag: e.item.key, icon: img(e.item.icon) });
  } else if (e.op === "removed") PD.notifs.list = PD.notifs.list.filter((n) => n.key !== e.key);
  else if (e.op === "all") PD.notifs.list = e.items || [];
  PD.emit("notifs_changed");
});
PD.on("hub_changed", () => { if (PD.hub.online && !PD.notifs.loaded) { PD.notifs.loaded = true; loadNotifs(); } });

// ── Photos ──
PD.page("photos", {
  title: "Photos", icon: I.photos,
  render(sec) {
    const grid = h("div", { className: "photogrid", id: "photoGrid" });
    sec.append(h("div", { className: "bar" }, btn("Refresh", () => loadPhotos(true)), btn("More", () => loadPhotos(false))), grid);
  },
  show() { if (!$("#photoGrid").children.length) loadPhotos(true); },
});
let photoOffset = 0;
async function loadPhotos(reset) {
  const grid = $("#photoGrid");
  if (!PD.hub.online) return grid.replaceChildren(needApp());
  if (reset) { photoOffset = 0; grid.replaceChildren(); }
  const r = await run(() => PD.ask("photos", "list", { offset: photoOffset, limit: 60 }, 60000));
  if (!r) return;
  photoOffset += (r.items || []).length;
  for (const p of r.items || []) {
    const tile = h("button", { className: "photo", title: `${p.name} · ${new Date(p.date).toLocaleString()}`, onclick: () => downloadPhoto(p) },
      p.thumb ? h("img", { src: img(p.thumb, "image/jpeg"), alt: p.name, loading: "lazy" }) : h("span", { textContent: p.name }),
      p.video ? h("span", { className: "badge", textContent: "▶" }) : "");
    grid.append(tile);
  }
  if (!grid.children.length) grid.append(empty("No photos, or the app has no permission to read them yet."));
}
async function downloadPhoto(p) {
  const parts = [];
  for (let offset = 0; ; ) {
    const r = await run(() => PD.ask("photos", "read", { id: p.id, offset }, 60000));
    if (!r) return;
    const bin = atob(r.data), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    parts.push(u);
    offset += u.length;
    if (r.eof || !u.length) break;
    PD.toast(`${p.name}: ${Math.floor((offset / p.size) * 100)}%`);
  }
  const a = h("a", { href: URL.createObjectURL(new Blob(parts, { type: p.mime })), download: p.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ── Files ──
PD.page("files", {
  title: "Phone files", icon: I.files,
  render(sec) {
    const drop = h("div", { className: "card drop-zone", textContent: "Drop files here to send them to the phone's Downloads (over phone control), or browse its storage below (through the phone app)." });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drop"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drop"); phoneReady() ? PD.adb.pushFiles(e.dataTransfer.files) : PD.storage.upload(e.dataTransfer.files); });
    sec.append(drop, h("div", { id: "storageBox" }));
    PD.storage?.render($("#storageBox"));
  },
  show() { PD.storage?.show(); },
});

// ── Clipboard ──
PD.clips = [];
PD.page("clipboard", {
  title: "Clipboard", icon: I.clipboard,
  render(sec) {
    const text = h("textarea", { rows: 3, placeholder: "Text to put on the phone's clipboard" });
    const list = h("div", { className: "list", id: "clipList" });
    sec.append(PD.syncCard("clip"), h("div", { className: "card" }, text, h("div", { className: "actions" },
      btn("Send to phone", () => sendClip(text.value), "primary"),
      btn("Open link on phone", () => openOnPhone(text.value.trim())),
      btn("Send this PC's clipboard", async () => { try { sendClip(await navigator.clipboard.readText()); } catch (e) { PD.toast(e.message, true); } }),
      btn("Get the phone's clipboard", () => (phoneReady() ? PD.send({ type: "adb_clipboard_get" }) : run(async () => { const r = await PD.ask("clip", "get"); if (r.text) PD.emit("phone_clip", r.text); }))))), h("h3", { textContent: "History" }), list);
    const draw = () => list.replaceChildren(...PD.clips.map((c) => h("div", { className: "item row" }, h("span", { className: "dim small", textContent: c.from === "phone" ? "from phone" : "to phone" }),
      h("span", { className: "grow clip", textContent: c.text }), btn("Copy", () => navigator.clipboard.writeText(c.text).then(() => PD.toast("Copied"))), btn("Send to phone", () => sendClip(c.text)))));
    PD.on("clips_changed", draw);
  },
});
/** A link opens on the phone: right away through phone control, else as a notification there. */
function openOnPhone(url) {
  if (!/^https?:[/][/][^ ]+$/i.test(url)) return PD.toast("Paste an http(s) link first", true);
  if (phoneReady()) PD.send({ type: "adb_action", action: "open_url", value: url });
  else run(() => PD.ask("link", "open", { url }), "Sent: tap the notification on the phone");
}
PD.openOnPhone = openOnPhone;
function sendClip(t) {
  if (!t) return;
  if (phoneReady()) PD.send({ type: "adb_clipboard_set", text: t });
  else run(() => PD.ask("clip", "set", { text: t }));
  addClip(t, "pc");
  PD.toast("On the phone's clipboard");
}
function addClip(text, from) {
  PD.clips = [{ text, from, at: Date.now() }, ...PD.clips.filter((c) => c.text !== text)].slice(0, 30);
  PD.emit("clips_changed");
}
PD.on("phone_clip", (t) => addClip(t, "phone"));
PD.on("evt_clip", (e) => { if (e.text) { addClip(e.text, "phone"); navigator.clipboard.writeText(e.text).catch(() => {}); } });

PD.on("adb_progress", (m) => { PD.toast(m.text); setTimeout(drawApp, 1500); });

// ── Connect ──
PD.page("connect", {
  title: "Connect", icon: I.connect,
  render(sec) {
    const doc = h("div", { className: "list" });
    sec.append(h("div", { className: "card" }, h("div", { className: "row" }, h("h3", { className: "grow", textContent: "Check everything" }), btn("Run checks", () => { doc.replaceChildren(empty("Checking…")); PD.send({ type: "phone_doctor" }); })), doc),
      h("div", { className: "card", id: "adbCard" }), h("div", { className: "card", id: "appCard" }));
    PD.on("phone_doctor", (m) => doc.replaceChildren(...m.checks.map((c) => h("div", { className: "item row" },
      h("span", { className: c.ok ? "pill ok" : "pill", textContent: c.ok ? "ok" : "to do" }), h("b", { textContent: c.name }), h("span", { className: "dim grow", textContent: c.detail })))));
    PD.on("adb_changed", drawAdb);
    PD.on("hub_changed", drawApp);
    PD.on("adb_qr", (m) => {
      const qr = qrcode(0, "M");
      qr.addData(m.text);
      qr.make();
      $("#adbQr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      $("#adbQrNote").textContent = "On the phone: Settings › Developer options › Wireless debugging › Pair device with QR code, then scan this.";
    });
    PD.on("adb_qr_end", (m) => { $("#adbQr").replaceChildren(); $("#adbQrNote").textContent = m.why === "paired" ? "Paired. Connecting…" : m.why === "stopped" ? "" : `Pairing ${m.why}.`; });
  },
  show() { PD.send({ type: "adb_state", reconnect: true }); drawAdb(); drawApp(); },
});
function drawAdb() {
  const box = $("#adbCard"), a = PD.adb.state;
  if (!box) return;
  const host = h("input", { placeholder: "Phone IP, e.g. 192.168.1.20", size: 18 }), port = h("input", { placeholder: "Port", size: 6 }), code = h("input", { placeholder: "6-digit code", size: 8 });
  box.replaceChildren(
    h("h3", { textContent: "Phone control (screen, apps, camera, sound, typing)" }),
    h("p", { className: "dim", textContent: "Works through Android's wireless debugging or a USB cable with USB debugging on. No root and nothing to grant on the phone beyond that. This PC fetches adb and scrcpy-server the first time." }),
    !a ? h("div", { className: "dim", textContent: "Checking…" })
      : !a.toolsReady && !a.devices?.length ? h("div", { className: "actions" }, btn("Get the tools (about 10 MB)", () => { PD.toast("Downloading adb and scrcpy-server…"); PD.send({ type: "adb_setup" }); }, "primary"))
      : h("div", {},
        a.devices.length ? h("div", { className: "list" }, a.devices.map((d) => h("div", { className: "item row" },
          h("span", { className: "grow" }, h("b", { textContent: d.model || d.serial }), h("span", { className: "dim", textContent: ` ${d.wireless ? "Wi-Fi" : "USB"} · ${d.state === "device" ? "ready" : d.state === "unauthorized" ? "allow USB debugging on the phone" : d.state}` })),
          d.serial === a.serial ? h("span", { className: "pill ok", textContent: "in use" }) : d.state === "device" ? btn("Use", () => PD.send({ type: "adb_select", serial: d.serial })) : "")))
          : empty("No phone yet. Pair one below, or plug it in with USB debugging on."),
        a.serial && h("div", { className: "actions" }, btn("Show screen", () => PD.adb.open("screen"), "primary"), btn("Disconnect", () => PD.send({ type: "adb_disconnect" }))),
        h("h4", { textContent: "Pair with a QR code" }),
        h("div", { className: "actions" }, btn(a.pairing ? "Showing QR…" : "Show pairing QR", () => PD.send({ type: "adb_qr_start" })), btn("Cancel", () => PD.send({ type: "adb_qr_stop" }))),
        h("div", { id: "adbQr", className: "qr" }), h("div", { id: "adbQrNote", className: "dim" }),
        h("h4", { textContent: "Or pair with a code" }),
        h("p", { className: "dim small", textContent: "Wireless debugging › Pair device with pairing code shows an IP, port and code." }),
        h("div", { className: "actions" }, host, port, code, btn("Pair", () => PD.send({ type: "adb_pair", host: host.value.trim(), port: port.value.trim(), code: code.value.trim() })), btn("Connect only", () => PD.send({ type: "adb_connect", host: host.value.trim(), port: port.value.trim() }))),
        a.error && h("div", { className: "bad", textContent: a.error })));
}
async function drawApp() {
  const box = $("#appCard");
  if (!box) return;
  const st = PD.hub.online ? await PD.ask("hub", "status").catch(() => null) : null;
  const perm = (id, label, on) => h("div", { className: "item row" }, h("span", { className: "grow", textContent: label }),
    on ? h("span", { className: "pill ok", textContent: "on" }) : btn("Turn on (on the phone)", () => run(() => PD.ask("hub", "grant", { what: id }), "Asked on the phone")));
  const viaAdb = phoneReady() ? h("div", { className: "actions" },
    btn("Install the app on the phone", () => PD.send({ type: "adb_install_app" })),
    btn("Grant all its permissions", () => PD.send({ type: "adb_grant_app" }))) : "";
  box.replaceChildren(h("h3", { textContent: "Phone app (notifications, texts, calls, photos, quick settings)" }), viaAdb,
    !PD.hub.online ? needApp()
      : !st ? empty("Asking the phone…")
      : h("div", { className: "list" },
        perm("notifications", "Notifications", st.notifications), perm("sms", "Texts", st.sms), perm("calls", "Calls and call log", st.calls),
        perm("contacts", "Contacts", st.contacts), perm("photos", "Photos", st.photos), perm("dnd", "Do not disturb", st.dnd), perm("settings", "Brightness", st.writeSettings)));
}

window.addEventListener("load", () => PD.start());
})();
