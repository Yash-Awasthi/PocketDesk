import fs from "node:fs";
import path from "node:path";

/** What a served asset is, by extension. */
function contentType(url) {
  if (url.endsWith(".js")) return "text/javascript";
  if (url.endsWith(".css")) return "text/css";
  if (url.endsWith(".svg")) return "image/svg+xml";
  if (url.endsWith(".webmanifest")) return "application/manifest+json";
  return "text/plain";
}

/** The hub page as this machine's own browser gets it: signed in, with the pairing QR and device list. */
export function withPcMetas(page, { token, pairLink, pairHub, pairFp }) {
  return page.replace(
    "</head>",
    `<meta name="pd-token" content="${token}">\n` +
      `<meta name="pd-qr" content="${pairLink}">\n` +
      `<meta name="pd-hub" content="${pairHub}">\n` +
      `<meta name="pd-fp" content="${pairFp}">\n</head>`,
  );
}

/**
 * The hub page and its own files: /vendor and /ui out of publicDir, path-traversal guarded, plus the
 * service worker, which must sit at the root to control the whole page.
 */
export function createStatic(publicDir) {
  return {
    page: fs.readFileSync(path.join(publicDir, "index.html"), "utf8"),
    /** Serves one of the page's assets; false when this request is not one (caller falls through). */
    serve(req, res) {
      if (!(req.url.startsWith("/vendor/") || req.url.startsWith("/ui/"))) return false;
      if (req.url.includes("..") || !/^[\w/.-]+$/.test(req.url)) return false;
      const file = path.join(publicDir, req.url);
      if (!fs.existsSync(file)) return false;
      res.writeHead(200, { "content-type": contentType(req.url), "cache-control": "no-cache" });
      res.end(fs.readFileSync(file));
      return true;
    },
    /** The service worker, which must control the plain-HTTP LAN page too, so it has no guard. */
    serveWorker(_req, res) {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      });
      res.end(fs.readFileSync(path.join(publicDir, "sw.js")));
    },
  };
}
