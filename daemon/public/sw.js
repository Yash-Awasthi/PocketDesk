// Offline shell for the hub: the hub is a single page that draws everything from one socket,
// so caching the shell is enough for read-only pages to load with the daemon unreachable.
"use strict";

const CACHE = "pocketdesk-shell-v1";
const SHELL = "/";
const ASSETS = [
  "/ui/app.css",
  "/ui/core.js",
  "/ui/phone.js",
  "/ui/hub.js",
  "/ui/share.js",
  "/ui/pages.js",
  "/ui/thispc.js",
  "/ui/computers.js",
  "/ui/extras.js",
  "/ui/running.js",
  "/ui/app.js",
  "/ui/manifest.webmanifest",
  "/vendor/qrcode.min.js",
];

// The loopback copy of the page carries the pairing token and the QR, which must never sit in
// CacheStorage on a shared browser profile. Strip them before anything is written to disk.
function stripSecrets(html) {
  return String(html).replace(/<meta name="pd-(token|qr|hub|fp)"[^>]*>\s*/g, "");
}

const EMERGENCY =
  '<!doctype html><meta charset="utf-8"><title>PocketDesk is offline</title>' +
  '<body style="font:16px system-ui;padding:2rem">' +
  "<h1>PocketDesk is offline</h1>" +
  "<p>This page is read-only until the PC is reachable again.</p>" +
  '<button onclick="location.reload()">Reload</button>';

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(SHELL, { cache: "no-store" });
      const html = stripSecrets(await res.text());
      await cache.put(
        SHELL,
        new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
      // One asset the daemon no longer serves must not fail the whole install.
      try {
        await cache.addAll(ASSETS);
      } catch {}
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || !/^https?:$/.test(url.protocol)) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(req.mode === "navigate" ? navigation(req) : asset(req));
});

// Network first: a live daemon must always win over a stale cached shell.
async function navigation(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      // Refresh the fallback entry with the same stripped markup the install wrote.
      const html = stripSecrets(await res.clone().text());
      try {
        await cache.put(
          SHELL,
          new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
        );
      } catch {}
    }
    return res;
  } catch {}
  const hit = await cache.match(SHELL);
  if (hit) return hit;
  return new Response(EMERGENCY, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// Cache first: the shell assets are versioned by CACHE, so a hit is never stale by accident.
async function asset(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // A redirect may land off-origin; only same-origin bytes belong in this cache.
    if (res && res.ok && new URL(res.url || req.url).origin === self.location.origin) {
      try {
        await cache.put(req, res.clone());
      } catch {}
    }
    return res;
  } catch {
    return Response.error();
  }
}
