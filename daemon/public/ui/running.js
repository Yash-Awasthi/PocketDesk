// SPDX-License-Identifier: GPL-3.0-or-later
// The Running page: what this PC is doing right now — the daemon's version, its ports, the live
// sessions and streams, and the policy switches. Answers `running_state` on demand.

import { PD } from "./core.js";

(() => {
const { h } = PD;
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });
const row = (label, value) => h("div", { className: "row" },
  h("span", { className: "dim grow", textContent: label }),
  h("b", { textContent: String(value) }));
const card = (title, ...rows) => h("div", { className: "card col" }, h("h3", { textContent: title }), ...rows);
const onOff = (v) => (v ? "on" : "off");

PD.page("running", {
  title: "Running",
  icon: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 3v3M10 14v3M3 10h3M14 10h3"/></svg>',
  render(sec) {
    const body = h("div", { className: "col" });
    sec.append(
      h("div", { className: "bar" },
        btn("Refresh", () => PD.send({ type: "running_state" })),
        h("button", {
          textContent: "Support bundle",
          title: "Download logs, status and versions for support (no secrets)",
          onclick: () => PD.send({ type: "diagnostic_bundle" }),
        })),
      body);
    const draw = (m) => {
      const v = m.version || {};
      const p = m.ports || {};
      const s = m.sessions || { count: 0, items: [] };
      const st = m.streams || {};
      const po = m.policy || {};
      const sessions = s.items.length
        ? s.items.map((it) => h("div", { className: "row small" },
          h("b", { textContent: it.harnessId || "?" }),
          h("span", { className: "dim", textContent: `${it.kind} · ${it.state || "unknown"}` }),
          h("code", { className: "dim", textContent: it.id.slice(0, 8) })))
        : [h("div", { className: "dim", textContent: "Nothing is running." })];
      body.replaceChildren(
        card("Daemon",
          row("Version", v.daemon || "unknown"),
          row("Protocol", v.protocol),
          row("Node", v.node || "unknown")),
        card("Ports",
          row("Daemon", p.daemon),
          row("Page", p.page),
          row("CLI", p.cli),
          row("USB", p.usb)),
        card("Sessions", row("Count", s.count), ...sessions),
        card("Streams",
          row("Video viewers", st.video),
          row("Desktop streams", st.desktop),
          row("Audio listeners", st.audio),
          row("Remote audio", st.remote)),
        card("Policy",
          row("Control", po.control ? "allowed" : "paused"),
          row("Remote access", onOff(po.remote)),
          row("Password", po.password ? "set" : "not set"),
          row("Two-factor", onOff(po.totp)),
          row("Screen recording", onOff(po.recording))));
    };
    PD.on("running_state", draw);
    // The bar's second button asks for a bundle; save it beside the phone's other downloads.
    PD.on("diagnostic_bundle", (m) => {
      const blob = new Blob([JSON.stringify(m, null, 2)], { type: "application/json" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `pocketdesk-diagnostic-${String(m.at || new Date().toISOString()).replace(/[:.]/g, "-")}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      PD.toast("Diagnostic bundle saved");
    });
  },
  show() { PD.send({ type: "running_state" }); },
});

// Only while the page is in front: a background hub tab should not keep asking the daemon.
setInterval(() => { if (PD.current === "running") PD.send({ type: "running_state" }); }, 5000);
})();
