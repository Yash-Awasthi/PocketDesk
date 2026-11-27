// SPDX-License-Identifier: GPL-3.0-or-later
// The Sessions page: the conversations every agent on this PC saved, searched and narrowed by
// agent, project and date. Reads history_list; file paths never leave the PC except as a label.

import { PD } from "./core.js";

(() => {
const { h } = PD;
const btn = (label, onclick, cls = "") => h("button", { className: cls, textContent: label, onclick });

const S = { items: [], q: "", agent: "", project: "", from: "", to: "" };
let box, pending = false;

// A project is the last folder of the working directory; the platform's separators both count.
const projectOf = (cwd) => {
  const parts = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "(unknown project)";
};
const dayStart = (v) => new Date(v + "T00:00:00").getTime();
const dayEnd = (v) => {
  const d = new Date(v + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return d.getTime() - 1;
};
const label = (it) => it.title || "(untitled conversation)";

PD.page("sessions", {
  title: "Sessions",
  icon: '<svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5"/><path d="M12.5 12.5L16 16"/></svg>',
  render(sec) {
    const q = h("input", { type: "search", placeholder: "Search titles, agents and projects" });
    const agent = h("select", {});
    const project = h("select", {});
    const from = h("input", { type: "date", title: "First day" });
    const to = h("input", { type: "date", title: "Last day" });
    const clear = btn("Clear", () => {
      q.value = "";
      agent.value = "";
      project.value = "";
      from.value = "";
      to.value = "";
      read();
    });
    const count = h("p", { className: "dim small" });
    const list = h("div", { className: "list" });
    for (const [el, text] of [
      [q, "Search sessions"],
      [agent, "Agent"],
      [project, "Project"],
      [from, "From date"],
      [to, "To date"],
    ])
      el.setAttribute("aria-label", text);

    sec.append(
      h("div", { className: "bar" }, q, agent, project, from, to, clear),
      count,
      list,
    );
    box = PD.stateBox(list, { retry: () => PD.send({ type: "history_list" }), empty: "No saved conversations on this PC yet." });

    function read() {
      S.q = q.value.trim().toLowerCase();
      S.agent = agent.value;
      S.project = project.value;
      S.from = from.value;
      S.to = to.value;
      draw();
    }
    for (const el of [q, from, to]) el.addEventListener("input", read);
    for (const el of [agent, project]) el.addEventListener("change", read);

    function fillOptions() {
      const keep = { agent: S.agent, project: S.project };
      const agents = [...new Set(S.items.map((it) => it.agent).filter(Boolean))].sort();
      const projects = [...new Set(S.items.map((it) => projectOf(it.cwd)))].sort();
      agent.replaceChildren(
        h("option", { value: "", textContent: "All agents" }),
        ...agents.map((a) => h("option", { value: a, textContent: a })),
      );
      project.replaceChildren(
        h("option", { value: "", textContent: "All projects" }),
        ...projects.map((a) => h("option", { value: a, textContent: a })),
      );
      // A filter that no longer exists falls back to every agent or project.
      agent.value = agents.includes(keep.agent) ? keep.agent : "";
      project.value = projects.includes(keep.project) ? keep.project : "";
      S.agent = agent.value;
      S.project = project.value;
    }

    function shown() {
      const lo = S.from ? dayStart(S.from) : null;
      const hi = S.to ? dayEnd(S.to) : null;
      return S.items.filter((it) => {
        const at = Number(it.updated) || 0;
        if (S.q && !`${label(it)} ${it.agent || ""} ${it.app || ""} ${it.cwd || ""}`.toLowerCase().includes(S.q)) return false;
        if (S.agent && it.agent !== S.agent) return false;
        if (S.project && projectOf(it.cwd) !== S.project) return false;
        if (lo != null && at < lo) return false;
        if (hi != null && at > hi) return false;
        return true;
      });
    }

    function draw() {
      const items = shown();
      count.textContent = S.items.length
        ? `${items.length} of ${S.items.length} saved conversations`
        : "No saved conversations on this PC yet.";
      list.replaceChildren(
        ...(items.length
          ? items.map((it) => {
              const meta = [it.app || it.agent || "agent", projectOf(it.cwd), new Date(it.updated).toLocaleString()];
              const title = h("div", { className: "grow" },
                h("b", { textContent: label(it) }),
                h("div", { className: "dim small", textContent: meta.join(" \u00b7 ") }));
              if (it.cwd) title.title = it.cwd;
              return h("div", { className: "item row" },
                h("span", { className: "pill", textContent: it.agent || "?" }),
                title);
            })
          : [h("div", { className: "empty", textContent: "No saved conversation matches these filters." })]));
    }

    PD.on("history", (m) => {
      pending = false;
      S.items = Array.isArray(m.items) ? m.items : [];
      fillOptions();
      if (!S.items.length) {
        count.textContent = "";
        box.show("empty");
        return;
      }
      box.clear();
      draw();
    });
    PD.on("error", (m) => {
      if (!pending) return;
      pending = false;
      box.show("error", m.message);
    });
  },
  show() {
    if (!PD.up()) return box?.show("error");
    box?.show("loading");
    pending = true;
    PD.send({ type: "history_list" });
  },
});
})();
