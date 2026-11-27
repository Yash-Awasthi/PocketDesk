// The hub installs as a PWA: a service worker caches the shell (with the pairing token and QR
// metas stripped) so read-only pages open while the daemon is unreachable.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import url from "node:url";
import { check, finish, makeTmp, startDaemon, teardown } from "./helpers.mjs";

const REPO = path.dirname(url.fileURLToPath(new URL("..", import.meta.url)));

// ---- Unit: run public/sw.js against minimal fakes -------------------------------

// Read the real worker so these copies cannot drift from what ships.
const swFile = path.join(REPO, "daemon", "public", "sw.js");
const swText = fs.readFileSync(swFile, "utf8");
const CACHE = swText.match(/const CACHE = "([^"]+)"/)[1];
const ASSETS = [...swText.match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const SHELL = "/";
// What the daemon serves the PC browser: the page plus the metas only loopback gets.
const SERVED =
  '<html><head><meta name="pd-token" content="tok"><meta name="pd-qr" content="qr"></head><body>hi</body></html>';

// Stands in for the browser's Response: the worker builds cached copies from stripped text.
class FakeResponse {
  constructor(body, init = {}) {
    this.body = String(body ?? "");
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
  }
  clone() {
    return this;
  }
  async text() {
    return this.body;
  }
  static error() {
    return new FakeResponse("", { status: 0 });
  }
}

// Stands in for one Cache: keys are shell paths or request URLs, values are responses.
class FakeCache {
  constructor() {
    this.map = new Map();
  }
  static key(k) {
    return typeof k === "string" ? k : k.url;
  }
  async match(req) {
    return this.map.get(FakeCache.key(req));
  }
  async put(req, res) {
    this.map.set(FakeCache.key(req), res);
  }
  async addAll(list) {
    for (const u of list) {
      if (!this.map.has(u)) this.map.set(u, await net.fetch(u));
    }
  }
}

const store = new FakeCache();
let offline = false;
const names = ["pocketdesk-shell-v0", CACHE];
const handlers = {};

// Stands in for the worker global scope.
const self = {
  location: { origin: "http://127.0.0.1:1" },
  addEventListener(type, fn) {
    handlers[type] = fn;
  },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
};

// Stands in for the network: the shell and every asset answer while online, nothing when offline.
const net = {
  fetch: async () => {
    if (offline) throw new Error("network down");
    return new FakeResponse(SERVED);
  },
};

const caches = {
  open: async () => store,
  keys: async () => names.slice(),
  delete: async (name) => {
    const i = names.indexOf(name);
    if (i >= 0) names.splice(i, 1);
    return i >= 0;
  },
};

const sandbox = { self, caches, fetch: net.fetch, Response: FakeResponse, URL, console };
vm.createContext(sandbox);
vm.runInContext(swText, sandbox, { filename: swFile });

// Every fake event only records the promise the worker handed over.
const drive = (type, event) => {
  let done;
  handlers[type]({ ...event, waitUntil: (p) => (done = p), respondWith: (p) => (done = p) });
  return done;
};

try {
  check(
    "install, activate and fetch handlers are registered",
    ["install", "activate", "fetch"].every((t) => typeof handlers[t] === "function"),
  );

  await drive("install", {});
  const shell = await store.match(SHELL);
  check("install caches the shell", !!shell);
  const shellText = shell ? await shell.text() : "";
  check(
    "the cached shell has no pairing token or QR",
    !shellText.includes("pd-token") && !shellText.includes("pd-qr") && !shellText.includes("tok"),
  );
  check("the cached shell still has the page body", shellText.includes("hi"));
  check(
    "install caches every shell asset",
    ASSETS.every((a) => store.map.has(a)),
  );

  // 52a38c2 made app.js the only entry; a stale pre-module cache killed the page, so the shell
  // list must follow the real import graph and the cache name must be a deliberate bump.
  check("the shell cache name is the module bump", CACHE === "pocketdesk-shell-v2");
  check("the shell cache name stays versioned", /^pocketdesk-shell-v\d+$/.test(CACHE));
  const walk = (file) => {
    const seen = new Set();
    const queue = [file];
    while (queue.length) {
      const cur = queue.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const src = fs.readFileSync(path.join(REPO, "daemon", "public", cur), "utf8");
      for (const m of src.matchAll(/^\s*import\b[^"']*["'](\.\/[^"']+\.js)["']/gm)) {
        queue.push(path.posix.join(path.posix.dirname(cur), m[1]));
      }
    }
    return [...seen];
  };
  const graph = walk("/ui/app.js");
  const missing = graph.filter((f) => !ASSETS.includes(f));
  check(
    "every module imported by /ui/app.js is in the shell list" +
      (missing.length ? ": missing " + missing.join(", ") : ""),
    missing.length === 0,
  );

  names.push("pocketdesk-shell-v9");
  await drive("activate", {});
  check("activate deletes every cache but the current one", names.length === 1 && names[0] === CACHE);

  // Offline navigation: fetch rejects, the cached stripped shell must answer.
  offline = true;
  const nav = { mode: "navigate", method: "GET", url: "http://127.0.0.1:1/x" };
  const fallback = await drive("fetch", { request: nav });
  check("offline navigation answers from the cache", !!fallback);
  const fallbackText = fallback ? await fallback.text() : "";
  check(
    "the offline fallback is the cached shell, still stripped",
    fallbackText.includes("hi") && !fallbackText.includes("pd-token"),
  );
  check("the offline fallback is not the emergency page", !fallbackText.includes("PocketDesk is offline"));
} catch (e) {
  check("service worker unit: " + e.message, false);
}

// ---- E2E: the daemon serves the worker and the page registers it ----------------

const PORT = 8963;
const CLI = 46963;
const tmp = makeTmp("pwa-");

// The daemon's banner precedes its listeners, so poll until the port answers.
const get = async (p) => {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}${p}`);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last || new Error(`no answer on ${PORT}${p}`);
};

const d = startDaemon(PORT, CLI, { token: "pwatoken", manifests: tmp, home: tmp });
try {
  await d.ready;
  const sw = await get("/sw.js");
  check("/sw.js answers 200", sw.status === 200);
  check("/sw.js is served as JavaScript", String(sw.headers.get("content-type")).includes("text/javascript"));
  check("/sw.js is allowed at the root scope", sw.headers.get("service-worker-allowed") === "/");
  const swBody = await sw.text();
  check("/sw.js is the shell worker", swBody.includes("pocketdesk-shell"));

  const page = await get("/");
  check("the hub page answers 200", page.status === 200);
  const pageBody = await page.text();
  const app = await get("/ui/app.js");
  check("the app module answers 200", app.status === 200);
  const appBody = await app.text();
  check("the hub page loads the app module", pageBody.includes("/ui/app.js"));
  check(
    "the app module registers the worker",
    appBody.includes('navigator.serviceWorker.register("/sw.js")'),
  );

  const manifest = await get("/ui/manifest.webmanifest");
  check("the web manifest is still served", manifest.status === 200);
} catch (e) {
  check("pwa e2e: " + e.message, false);
}

await teardown(tmp);
finish();
