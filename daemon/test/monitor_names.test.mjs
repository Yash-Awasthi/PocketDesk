// Monitor names and the hub's display order, saved beside config.json and never tied to a capture
// index. No daemon and no screen: a fake ctx is enough.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

// config.js reads RH_HOME at import time, so relocate state before loading any daemon module.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-monitors-"));
process.env.RH_HOME = home;
const { keyOf, label, loadPrefs, prefsPath, savePrefs } = await import("../src/monitor_names.js");
const { default: remoteHandlers } = await import("../src/handlers/remote.js");

// ── keys ──
check("a key is adapter:output", keyOf({ adapter: 0, output: 2, index: 3 }) === "0:2");
check("without adapter/output the display id is the key", keyOf({ id: "abc", index: 3 }) === "abc");
check("last resort is the capture index", keyOf({ index: 4 }) === "4");

// ── labelling ──
const BASE = [
  { index: 0, adapter: 0, output: 0, name: "DELL U2720Q", x: 0, y: 0, w: 3840, h: 2160, primary: true },
  { index: 1, adapter: 0, output: 1, name: "LG HDR 4K", x: 3840, y: 0, w: 2560, h: 1440, primary: false },
  { index: 2, adapter: 1, output: 0, name: "", x: 6400, y: 0, w: 1920, h: 1080, primary: false },
];
const named = label(BASE, { names: { "0:1": "Left wing" }, order: [] });
check("a saved name becomes the title", named.monitors[1].title === "Left wing");
check("otherwise the hardware name is used", named.monitors[0].title === "DELL U2720Q");
check("a nameless screen is Display N", named.monitors[2].title === "Display 3");
check("labelling keeps the capture order", named.monitors.map((m) => m.index).join() === "0,1,2");
check("no saved order means capture order", named.order.join() === "0,1,2");

const stale = label(BASE, { names: {}, order: [2, 9, 0] });
check("a stale index drops out of the order", stale.order.join() === "2,0,1");
check("a new screen lands at the end", stale.order[stale.order.length - 1] === 1);
check(
  "the saved order wins over capture order",
  label(BASE, { names: {}, order: ["1:0", 0] }).order.join() === "2,0,1",
);

// ── the file ──
check("prefs live beside config.json", prefsPath() === path.join(home, "monitors.json"));
check(
  "a missing file is the defaults",
  JSON.stringify(loadPrefs()) === JSON.stringify({ names: {}, order: [] }),
);
fs.writeFileSync(prefsPath(), "{not json");
check(
  "a corrupt file is the defaults too",
  loadPrefs().order.length === 0 && !Object.keys(loadPrefs().names).length,
);
fs.writeFileSync(
  prefsPath(),
  JSON.stringify({
    names: { "0:0": "  Desk  ", "0:1": 7, "0:2": "", "0:3": "x".repeat(80) },
    order: [1, "1:0", 1.5, {}, null],
  }),
);
const junk = loadPrefs();
check(
  "names keep only trimmed strings of 1..40 chars",
  junk.names["0:0"] === "Desk" && Object.keys(junk.names).length === 1,
);
check("order keeps indices and stable keys only", junk.order.join() === "1,1:0");

savePrefs({ names: { "0:1": "Left wing" }, order: ["0:2", "0:0"] });
check(
  "save then load round-trips",
  JSON.stringify(loadPrefs()) === JSON.stringify({ names: { "0:1": "Left wing" }, order: ["0:2", "0:0"] }),
);
check("the file lands where prefsPath says", fs.existsSync(prefsPath()));
if (process.platform !== "win32")
  check("the file is private", (fs.statSync(prefsPath()).mode & 0o777) === 0o600);

// ── handlers, over a fake ctx ──
fs.rmSync(prefsPath(), { force: true });
const sent = [];
const access = { controlAllowed: true };
const ctx = {
  send: (_ws, m) => sent.push(m),
  desktop: { monitors: async () => ({ ok: true, monitors: BASE }), monitorList: BASE.slice() },
  video: { monitor: null },
  access,
  desktopWatchers: new Set(),
  videoWatchers: new Set(),
  audioListeners: new Set(),
  recorder: { enabled: false },
  clippy: {},
  syncAudio() {},
  monitorRefresh() {},
};
const h = remoteHandlers(ctx);
const ws = { _clientId: "t", _viewOnly: false };
const last = (type) => [...sent].reverse().find((m) => m.type === type);
const clear = () => (sent.length = 0);

await h.desktop_monitors(ws, {});
check("the list is labelled on the way out", last("desktop_monitors").monitors[0].title === "DELL U2720Q");

clear();
await h.desktop_monitor_rename(ws, { index: 1, name: "Left wing" });
check(
  "rename is acknowledged",
  last("desktop_monitor_rename").ok === true && last("desktop_monitor_rename").index === 1,
);
check("the re-sent list shows the new title", last("desktop_monitors").monitors[1].title === "Left wing");
check("the name is saved under the stable key", loadPrefs().names["0:1"] === "Left wing");

clear();
await h.desktop_monitor_rename(ws, { index: 1, name: "   " });
check("an empty name restores the hardware name", last("desktop_monitors").monitors[1].title === "LG HDR 4K");
check("an empty name deletes the saved one", loadPrefs().names["0:1"] === undefined);

clear();
await h.desktop_monitor_rename(ws, { index: 7, name: "Nope" });
check("an out-of-range index is refused", last("desktop_monitor_rename").ok === false);
clear();
await h.desktop_monitor_rename(ws, { index: "1", name: "Nope" });
check("a non-integer index is refused", last("desktop_monitor_rename").ok === false);

clear();
await h.desktop_monitor_order(ws, { order: [2, 0, 1] });
check("a new order is acknowledged", last("desktop_monitor_order").ok === true);
check("the re-sent list carries it", last("desktop_monitors").order.join() === "2,0,1");
check("the order is saved as stable keys", loadPrefs().order.join() === "1:0,0:0,0:1");
check("a fresh load still yields the order", label(BASE, loadPrefs()).order.join() === "2,0,1");

clear();
await h.desktop_monitor_order(ws, { order: [0, 0, 1] });
check("a repeated index is a bad order", last("desktop_monitor_order").ok === false);
clear();
await h.desktop_monitor_order(ws, { order: [0, 1] });
check("a short order is a bad order", last("desktop_monitor_order").ok === false);
clear();
await h.desktop_monitor_order(ws, { order: [0, 1, "2"] });
check("a non-integer order is a bad order", last("desktop_monitor_order").ok === false);

access.controlAllowed = false;
clear();
await h.desktop_monitor_rename(ws, { index: 1, name: "Left wing" });
check("paused control refuses a rename", last("desktop_monitor_rename").ok === false);
clear();
await h.desktop_monitor_order(ws, { order: [2, 0, 1] });
check("paused control refuses a reorder", last("desktop_monitor_order").ok === false);

fs.rmSync(home, { recursive: true, force: true });
finish();
