// SPDX-License-Identifier: GPL-3.0-or-later
// The Screens page: name this PC's monitors and choose the order the hub draws them in. Names and
// order live on the PC in monitors.json; the capture indices behind them never move.

import { PD } from "./core.js";

(() => {
const { h } = PD;

PD.page("screens", {
  title: "Screens",
  icon: '<svg viewBox="0 0 20 20"><rect x="2" y="4" width="16" height="10" rx="1.5"/><path d="M7 17h6"/></svg>',
  render(sec) {
    const body = h("div", { className: "col" });
    sec.append(body);
    const draw = (m) => {
      const monitors = m.monitors || [];
      const byIndex = new Map(monitors.map((x) => [x.index, x]));
      const indices = m.order && m.order.length ? m.order : monitors.map((x) => x.index);
      const list = indices.map((i) => byIndex.get(i)).filter(Boolean);
      if (!list.length) {
        body.replaceChildren(h("div", { className: "dim", textContent: "No monitors reported by this PC." }));
        return;
      }
      body.replaceChildren(
        ...list.map((mon, at) => {
          const name = h("input", { type: "text", value: mon.title || "", placeholder: "Name this screen" });
          const save = () => PD.send({ type: "desktop_monitor_rename", index: mon.index, name: name.value });
          name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
          const move = (step) => {
            const order = list.map((x) => x.index);
            const to = at + step;
            if (to < 0 || to >= order.length) return;
            [order[at], order[to]] = [order[to], order[at]];
            PD.send({ type: "desktop_monitor_order", order });
          };
          return h("div", { className: "card col" },
            h("div", { className: "row" },
              h("b", { className: "grow", textContent: mon.title || `Display ${mon.index + 1}` }),
              h("span", { className: "dim small", textContent: `${mon.w} x ${mon.h}` }),
              mon.primary ? h("span", { className: "pill", textContent: "main" }) : ""),
            name,
            h("div", { className: "bar actions" },
              h("button", { textContent: "Save", onclick: save }),
              h("button", { textContent: "Up", disabled: at === 0, onclick: () => move(-1) }),
              h("button", { textContent: "Down", disabled: at === list.length - 1, onclick: () => move(1) })));
        }),
      );
    };
    PD.on("desktop_monitors", draw);
    PD.on("desktop_monitor_rename", (m) => { if (!m.ok) PD.toast(m.error || "could not name that screen", true); });
    PD.on("desktop_monitor_order", (m) => { if (!m.ok) PD.toast(m.error || "could not reorder the screens", true); });
  },
  show() { PD.send({ type: "desktop_monitors" }); },
});
})();
