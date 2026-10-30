// SPDX-License-Identifier: GPL-3.0-or-later
// What the PocketDesk app on the phone answers for the PC: notifications, texts, calls, contacts,
// quick settings, media, battery and photos. Requests go out as phone_req and come back as
// phone_res; the phone pushes changes as phone_evt.
"use strict";

(() => {
const PD = (window.PD ||= {});
let rid = 0;
const waiting = new Map();
PD.hub = { online: false, name: null, state: {} };

PD.ask = (svc, op, args = {}, timeout = 30000) => new Promise((resolve, reject) => {
  const id = ++rid;
  waiting.set(id, { resolve, reject });
  PD.send({ type: "phone_req", rid: id, svc, op, ...args });
  setTimeout(() => { if (waiting.delete(id)) reject(new Error("the phone did not answer")); }, timeout);
});
PD.on("phone_res", (m) => {
  const w = waiting.get(m.rid);
  if (!w) return;
  waiting.delete(m.rid);
  m.ok === false ? w.reject(new Error(m.error || "failed")) : w.resolve(m);
});
PD.on("phone_hub", (m) => {
  PD.hub.online = m.online;
  PD.hub.name = m.name;
  for (const [svc, e] of Object.entries(m.last || {})) PD.hub.state[svc] = e;
  PD.emit("hub_changed");
});
PD.on("phone_evt", (m) => {
  PD.hub.state[m.svc] = m;
  PD.hub.online = true;
  PD.emit(`evt_${m.svc}`, m);
  PD.emit("hub_changed");
});
PD.on("welcome", () => { PD.send({ type: "phone_hub" }); PD.send({ type: "adb_state", reconnect: true }); });
// The phone app connecting or leaving shows up as a device change; asking again is cheap.
setInterval(() => { if (PD.ws?.readyState === 1) PD.send({ type: "phone_hub" }); }, 15000);
})();
