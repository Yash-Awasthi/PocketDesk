// SPDX-License-Identifier: GPL-3.0-or-later
// "This PC": the one place for pairing, security and this install, on the PC itself.
// It replaces the separate /pair settings page: same token, same loopback-only endpoints, but inside
// the hub, so pairing, the QR and the switches are not a second frontend to find.
"use strict";

(() => {
const PD = window.PD;
const { h, $ } = PD;
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });
const api = (p, body) => fetch(`${p}?k=${encodeURIComponent(PD.localToken)}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
// margin is the quiet zone the spec asks for (4 modules); the svg then scales to .qr's width.
const qrSvg = (text, cell = 8) => {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 4, scalable: true });
};
const fmt = (t) => (t ? new Date(t).toLocaleString() : "never");

const S = { status: null, devices: [], audit: { events: [], categories: [] }, totpOn: false, totpOffer: false, totpSecret: "", qrTab: "app" };
let boxes = {}; // the DOM the paint step updates, so nothing is rebuilt while a field has focus

PD.registerThisPc = () => PD.page("thispc", {
  title: "This PC",
  icon: '<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="10" rx="1.2"/><path d="M7 17h6M10 13.5V17"/></svg>',
  render(sec) {
    if (!PD.localToken) {
      sec.append(h("div", { className: "card dim", textContent: "Open this page on the PC itself to pair a phone and change its settings." }));
      return;
    }
    // ── Pairing ──
    const pwInput = h("input", { type: "password", placeholder: "Connection password (blank = none)", autocomplete: "new-password", style: "flex:1;min-width:220px" });
    const tokenInput = h("input", { type: "text", readOnly: true, value: PD.localToken, style: "width:min(520px,100%)", onfocus: (e) => e.target.select() });
    tokenInput.setAttribute("aria-label", "Pairing token");
    // One code at a time. Side by side, a phone's scanner locked onto whichever it framed first (the
    // browser code, every time) instead of the app's, so the two are tabs now.
    const qrBox = h("div", { className: "qr" });
    const qrNote = h("p", { className: "dim small", style: "margin:8px 0 0" });
    const hubLine = h("div", { className: "dim small" });
    const tabs = [["app", "PocketDesk app"], ["web", "Phone browser"]].map(([key, label]) =>
      h("button", { className: "tab", role: "tab", "aria-selected": "false", textContent: label, onclick: () => { S.qrTab = key; paintQr(); } }));
    const paintQr = () => {
      const app = S.qrTab !== "web";
      tabs[0].classList.toggle("on", app);
      tabs[1].classList.toggle("on", !app);
      tabs[0].setAttribute("aria-selected", String(app));
      tabs[1].setAttribute("aria-selected", String(!app));
      qrBox.innerHTML = app ? (PD.pairPayload ? qrSvg(PD.pairPayload) : "") : (PD.hubUrl ? qrSvg(PD.hubUrl) : "");
      qrNote.textContent = app
        ? "Scan with the PocketDesk app: Connect tab › Scan QR. It pairs this PC with its address and certificate fingerprint."
        : "Scan with the phone's camera, not the app's scanner: the app only accepts its own code. The first visit warns that the certificate is not trusted — tap Advanced › Proceed — and the #t= link signs you in, no app or password needed.";
      hubLine.textContent = app ? "" : (PD.hubUrl || "the LAN address is not available yet");
    };
    paintQr();
    sec.append(
      h("div", { className: "card" },
        h("h3", { textContent: "Pair a phone" }),
        h("div", { className: "tabs", role: "tablist" }, ...tabs),
        qrBox, qrNote, hubLine,
        h("p", { className: "dim small", textContent: "If a code does not scan, enter the token by hand in the app (or in this browser's login box)." }),
        h("div", { className: "form" },
          h("label", {}, "Token"),
          tokenInput,
          btn("Copy token", () => navigator.clipboard.writeText(PD.localToken).then(() => PD.toast("Token copied"), () => PD.toast("Could not copy", true))),
          btn("Copy app link", () => navigator.clipboard.writeText(PD.pairPayload || "").then(() => PD.toast("Pairing link copied"), () => PD.toast("Could not copy", true))))),

      // ── Security ──
      h("div", { className: "card" },
        h("h3", { textContent: "Security" }),
        (boxes.remote = h("label", { className: "check" }, h("input", { type: "checkbox", onchange: (e) => api("/access/remote", { on: e.target.checked }).then(paint) }), h("span", {}, h("b", { textContent: "Remote access" }), h("span", { className: "dim", textContent: " Off closes every phone and browser, at home and away. PocketDesk keeps running so it can be switched back on here." })))),
        (boxes.control = h("label", { className: "check" }, h("input", { type: "checkbox", onchange: (e) => api("/access/control", { allowed: e.target.checked }).then(paint) }), h("span", {}, h("b", { textContent: "Allow this phone to control the PC" }), h("span", { className: "dim", textContent: " Off watches the screen but never clicks or types." })))),
        (boxes.record = h("label", { className: "check" }, h("input", { type: "checkbox", onchange: (e) => api("/access/record", { on: e.target.checked }).then(paint) }), h("span", {}, h("b", { textContent: "Record remote sessions" }), h("span", { className: "dim", textContent: " MP4 of the watched screen and every terminal, into .pocketdesk/recordings." })))),
        h("div", { className: "form" }, pwInput,
          btn("Save password", () => api("/access/password", { password: pwInput.value }).then((s) => { pwInput.value = ""; paint(s); PD.toast("Password saved"); }))),
        (boxes.pwState = h("p", { className: "dim small" }))),

      // ── Two-factor ──
      h("div", { className: "card" },
        h("h3", { textContent: "Two-factor pairing" }),
        (boxes.totpState = h("p", { className: "dim small" })),
        (boxes.totpNew = h("div", { hidden: true, className: "col" })),
        h("div", { className: "actions" },
          (boxes.totpCode = h("input", { type: "text", placeholder: "6-digit code", inputMode: "numeric", maxLength: 6, hidden: true, style: "width:8em" })),
          (boxes.totpBtn = btn("Set up", onTotp))),
        (boxes.totpErr = h("p", { className: "bad small" }))),

      // ── Devices ──
      h("div", { className: "card" },
        h("div", { className: "bar" }, h("h3", { className: "grow", textContent: "Devices" }), btn("Refresh", () => load())),
        (boxes.devices = h("div", { className: "list" })),
        h("p", { className: "dim small", textContent: "Revoking disconnects the device and changes the pairing token, so the old QR stops working while other phones keep their own." })),

      // Activity: only what the device store timed, and a plain line for what it never kept.
      h("div", { className: "card" },
        h("div", { className: "bar" }, h("h3", { className: "grow", textContent: "Activity" }), btn("Refresh", () => load())),
        (boxes.audit = h("div", { className: "list" })),
        (boxes.auditMissing = h("div", { className: "col" })),
        h("p", { className: "dim small", textContent: "Pairing and device events come from the device store, the only history the daemon keeps with timestamps." })),

      // ── Uninstall ──
      h("div", { className: "card" },
        h("h3", { textContent: "Remove PocketDesk" }),
        h("p", { className: "dim", textContent: "Uninstalls from this PC and stops the daemon. Settings, paired phones and keys are kept unless you choose to delete them." }),
        h("div", { className: "actions" },
          btn("Uninstall PocketDesk", () => uninstall(false)),
          btn("Uninstall and delete its data", () => uninstall(true), "danger"))));
  },
  show() { load(); },
});

function paint(s) {
  if (s && typeof s === "object") {
    S.status = { ...(S.status || {}), ...s };
    if ("totpEnabled" in s) S.totpOn = !!s.totpEnabled;
    if (typeof s.hasPassword === "boolean") S.hasPassword = s.hasPassword;
  }
  const st = S.status || {};
  if (boxes.remote) boxes.remote.querySelector("input").checked = st.remoteOn !== false;
  if (boxes.control) boxes.control.querySelector("input").checked = st.controlAllowed !== false;
  if (boxes.record) boxes.record.querySelector("input").checked = !!st.recording;
  if (boxes.pwState) {
    boxes.pwState.textContent = st.hasPassword ? "A password is set: asked on every connect, even with a valid pairing." : "No password set: the pairing token alone is full control.";
    boxes.pwState.className = st.hasPassword ? "small ok" : "small bad";
  }
  paintTotp();
  drawDevices();
}

function paintTotp() {
  if (!boxes.totpState) return;
  boxes.totpBtn.textContent = S.totpOn ? "Turn off" : S.totpOffer ? "Turn on" : "Set up";
  boxes.totpCode.hidden = !(S.totpOn || S.totpOffer);
  boxes.totpState.textContent = S.totpOn
    ? "On: pairing a new phone also needs a code from your authenticator app. Paired phones are not asked."
    : "Off: the pairing QR alone pairs a new phone.";
}

function onTotp() {
  boxes.totpErr.textContent = "";
  if (!S.totpOn && !S.totpOffer) {
    api("/access/totp/setup", {}).then((o) => {
      if (!o?.ok) { boxes.totpErr.textContent = o?.error || "Could not start two-factor setup"; return; }
      S.totpOffer = true;
      S.totpSecret = o.secret;
      boxes.totpNew.hidden = false;
      boxes.totpNew.replaceChildren(
        h("div", { className: "qr", innerHTML: qrSvg(o.uri) }),
        h("p", { className: "dim small", textContent: `Or enter this key in the app: ${o.secret}` }));
      paintTotp();
    });
    return;
  }
  const path = S.totpOn ? "/access/totp/disable" : "/access/totp/enable";
  api(path, { code: (boxes.totpCode.value || "").trim() }).then((r) => {
    if (!r.ok) { boxes.totpErr.textContent = "Wrong code, try the next one."; boxes.totpCode.value = ""; return; }
    S.totpOn = !!r.totpEnabled;
    S.totpOffer = false;
    boxes.totpNew.hidden = true;
    boxes.totpCode.value = "";
    paint(r);
  });
}

function drawDevices() {
  if (!boxes.devices) return;
  const items = S.devices.slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  if (!items.length) return boxes.devices.replaceChildren(h("p", { className: "dim small", textContent: "No device has connected yet." }));
  boxes.devices.replaceChildren(...items.map((d) => {
    const row = h("div", { className: "item row" });
    const meta = [d.platform || "unknown", `last seen ${fmt(d.lastSeen)}`];
    if (d.lastIp) meta.push(d.lastIp);
    meta.push(d.transport ? `via ${d.transport}` : "transport unknown");
    const note = h("input", { type: "text", value: d.note || "", placeholder: "Note for this device", style: "margin-top:6px;max-width:320px" });
    note.setAttribute("aria-label", `Note for ${d.name}`);
    note.addEventListener("change", () =>
      api("/access/devices/note", { clientId: d.id, note: note.value }).then((r) => {
        if (r?.ok) { d.note = note.value.trim(); PD.toast("Note saved"); }
        else PD.toast(r?.error || "Could not save the note", true);
      }));
    const info = h("div", { className: "grow" },
      h("b", { textContent: d.name + (d.online ? " (online)" : "") + (d.revoked ? " (revoked)" : "") }),
      h("div", { className: "dim small", textContent: meta.join(" · ") }),
      note);
    row.append(info);
    if (d.revoked) {
      row.append(btn("Allow", () => api("/access/devices/allow", { clientId: d.id }).then(load)));
      row.append(btn("Remove", () => api("/access/devices/remove", { clientId: d.id }).then(load)));
    } else {
      row.append(btn("Revoke", () => {
        if (!confirm(`Revoke ${d.name}? It is disconnected now and must pair again.`)) return;
        api("/access/devices/revoke", { clientId: d.id }).then((r) => {
          // Revoking rotates the pairing token, and this page's key is that token.
          if (r?.pairingToken) { PD.localToken = r.pairingToken; location.replace(location.pathname + "#go=thispc&t=" + encodeURIComponent(r.pairingToken)); }
          else load();
        });
      }));
    }
    return row;
  }));
}

function drawAudit() {
  if (!boxes.audit) return;
  const events = (S.audit.events || []).slice(0, 30);
  boxes.audit.replaceChildren(
    ...(events.length
      ? events.map((e) => h("div", { className: "item" }, h("b", { textContent: e.text }), h("div", { className: "dim small", textContent: fmt(e.at) })))
      : [h("p", { className: "dim small", textContent: "No pairing or device events recorded yet." })]));
  const missing = (S.audit.categories || []).filter((c) => !c.recorded);
  boxes.auditMissing.replaceChildren(
    ...missing.map((c) => h("p", { className: "dim small", textContent: `${c.label}: not recorded; ${c.reason}.` })));
}

function uninstall(removeData) {
  if (!confirm("Uninstall PocketDesk from this PC? Every phone is disconnected and the daemon stops.")) return;
  const wipe = removeData || confirm("Also delete its settings, paired phones and saved logins?\n\nOK = delete them, Cancel = keep them for a reinstall.");
  api("/access/uninstall", { removeData: wipe }).then((r) => {
    PD.toast(r.ok ? "Uninstalling; Windows may ask for permission" : r.error || "Could not uninstall", !r.ok);
  });
}

function load() {
  if (!PD.localToken) return;
  api("/access").then(paint).catch(() => {});
  api("/access/devices").then((r) => { S.devices = r.items || []; drawDevices(); }).catch(() => {});
  api("/access/audit").then((r) => { S.audit = r || S.audit; drawAudit(); }).catch(() => {});
}
})();
