import crypto from "node:crypto";
import { VERSION } from "../version.js";
import { isLoopback } from "./transport.js";

/**
 * Everything a browser can ask for, as match/handle pairs tried in order. Adding a route means one
 * entry here: server.js calls createRoutes once and never learns the path list.
 *
 * An entry without `match` always runs; a handle that returns false falls through to the next one.
 */
export function createRoutes(ctx) {
  const { staticFiles, pageForPc, allSessions, bootstrap, localSettings, token } = ctx;

  /** The `?k=` key is the pairing token itself, compared in constant time. */
  function keyOk(req) {
    const key = new URL(req.url, "http://x").searchParams.get("k") || "";
    const t = token();
    return key.length === t.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(t));
  }

  const routes = [
    // The page's own assets first: a missing file falls through to the hub page.
    { handle: (req, res) => staticFiles.serve(req, res) },
    {
      match: (req) => req.url === "/health",
      handle(req, res) {
        res.writeHead(200, { "content-type": "application/json" });
        // Anyone on the network may probe liveness; only this machine learns what answers and how busy it is.
        // No global error store exists yet; video.lastError is created after this table in server.js.
        res.end(
          JSON.stringify(
            isLoopback(req)
              ? {
                  status: "healthy",
                  service: "pocketdesk",
                  version: VERSION,
                  uptimeMs: Math.round(process.uptime() * 1000),
                  sessions: allSessions().length,
                  lastError: null,
                  lastErrorScope: null,
                }
              : { status: "healthy" },
          ),
        );
        setImmediate(bootstrap);
      },
    },
    {
      match: (req) => req.url === "/sw.js",
      handle(req, res) {
        staticFiles.serveWorker(req, res);
      },
    },
    {
      // The launcher's check before it hands the token to a plain-HTTP page: only the daemon can sign its nonce.
      match: (req) => req.url.startsWith("/prove?") && isLoopback(req),
      handle(req, res) {
        const n = new URL(req.url, "http://x").searchParams.get("n") || "";
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(crypto.createHmac("sha256", token()).update(n).digest("hex"));
      },
    },
    {
      // Local, token-gated settings the pair page drives; the dispatcher lives in server.js.
      match: (req) => req.url.startsWith("/access"),
      handle: (req, res) => localSettings(req, res),
    },
    {
      // /pair was its own settings document; it is now the hub's This PC page, so every launcher and
      // bookmark that still opens it lands there signed in.
      match: (req) => req.url.startsWith("/pair?") && isLoopback(req) && keyOk(req),
      handle(_req, res) {
        res.writeHead(302, { location: `/#go=thispc&t=${token()}`, "cache-control": "no-store" }).end();
      },
    },
    {
      match: (req) => req.url.startsWith("/pair"),
      handle(_req, res) {
        res.writeHead(403).end();
      },
    },
    {
      handle(req, res) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(isLoopback(req) ? pageForPc() : staticFiles.page);
      },
    },
  ];

  return {
    handle(req, res) {
      for (const route of routes) {
        if (route.match && !route.match(req)) continue;
        const handled = route.handle(req, res);
        if (handled !== false) return;
      }
    },
  };
}
