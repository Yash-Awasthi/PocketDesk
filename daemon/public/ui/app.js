// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's single entry: it loads every page module in the order they were once script tags, then
// starts the app once the page has loaded.
import { PD } from "./core.js";
import "./phone.js";
import "./hub.js";
import "./share.js";
import "./pages.js";
import "./sessions.js";
import "./thispc.js";
import "./computers.js";
import "./extras.js";
import "./running.js";
import "./screens.js";

// The Connect button had an inline onclick="PD.connect()"; a module owns it now that there is no
// global PD.
document.querySelector("#login .primary").addEventListener("click", () => PD.connect());

window.addEventListener("load", () => PD.start());

// Service workers need a secure context, so the plain-HTTP LAN page just skips the offline shell.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
