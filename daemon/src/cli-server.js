import http from "node:http";
import crypto from "node:crypto";
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";
import * as toolApproval from "./tool_approval.js";
import * as registry from "./registry.js";
import { render } from "./vt.js";

function allSessions() {
  return [...sessions.summary(), ...chat.summary()];
}

let cliServer = null;

/** `broadcast` reaches every connected client, so a terminal started here shows up on the phone too. */
export function start(getToken, { broadcast = () => {}, allSessions: listAll = allSessions } = {}, port = Number(process.env.RH_CLI_PORT) || 4679) {
  cliServer = http.createServer((req, res) => {
    // A DNS-rebound web page reaches 127.0.0.1 under its own Host.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || "")) {
      res.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /i, "");
    if (req.url === "/approval" && req.method === "POST" && toolApproval.keyMatches(bearer)) {
      let body = "";
      req.on("data", (d) => {
        body += d;
        if (body.length > 64 << 10) req.destroy();
      });
      req.on("end", async () => {
        try {
          const result = await toolApproval.request(JSON.parse(body));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // Loopback admits every local account, so the master token is required too.
    const given = Buffer.from(bearer);
    const want = Buffer.from(getToken());
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405).end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 64 << 10) req.destroy();
    });
    req.on("end", () => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      try {
        let result;
        const term = path.match(/^\/term\/(\w+)\/(in|screen|stream|resize|kill)$/);
        const s = term && sessions.get(term[1]);
        if (term && (!s || s.exitCode !== null)) {
          res.writeHead(404).end(JSON.stringify({ error: `no live terminal: ${term[1]}` }));
          return;
        }
        const json = () => (body ? JSON.parse(body) : {});

        if (path === "/term" && req.method === "GET") {
          result = sessions.summary();
        } else if (path === "/term" && req.method === "POST") {
          const { harness = "shell", cwd } = json();
          const m = registry.get(String(harness));
          if (!m || m.adapter !== "terminal" || !registry.isInstalled(m.id)) {
            res.writeHead(400).end(JSON.stringify({ error: `not an installed terminal tool: ${harness}` }));
            return;
          }
          result = sessions.create({ harnessId: m.id, bin: m.bin, cwd }, broadcast);
          broadcast({ type: "sessions", items: listAll() });
        } else if (term?.[2] === "in" && req.method === "POST") {
          result = { ok: sessions.write(s.id, String(json().data ?? "")) };
        } else if (term?.[2] === "resize" && req.method === "POST") {
          const { cols, rows } = json();
          result = { ok: sessions.resize(s.id, cols, rows) };
        } else if (term?.[2] === "kill" && req.method === "POST") {
          result = { ok: sessions.kill(s.id) };
        } else if (term?.[2] === "screen") {
          // ponytail: rebuilt from scrollback on each read; keep a live VT per session if reads get frequent.
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(render(s.scrollback, s.cols, s.rows) + "\n");
          return;
        } else if (term?.[2] === "stream") {
          // The replay first, then live output, until the terminal ends or the client leaves.
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-cols": s.cols, "x-rows": s.rows });
          res.write(s.scrollback);
          const out = (e) => { if (e.id === s.id) res.write(e.text); };
          const end = (e) => { if (e.id === s.id) res.end(); };
          sessions.sessionEvents.on("output", out);
          sessions.sessionEvents.on("exit", end);
          res.on("close", () => { sessions.sessionEvents.off("output", out); sessions.sessionEvents.off("exit", end); });
          return;
        } else if (path === "/shutdown" && req.method === "POST") {
          // An elevated daemon cannot be killed by an unelevated installer, so it is asked to stop instead.
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
          setImmediate(() => process.emit("SIGTERM"));
          return;
        } else if (path === "/sessions") {
          result = allSessions();
        } else if (path === "/status") {
          const sessions = allSessions();
          const summary = {
            total: sessions.length,
            running: sessions.filter((s) => s.state === "running").length,
            idle: sessions.filter((s) => s.state === "idle").length,
            waiting: sessions.filter((s) => s.state === "waiting").length,
            errored: sessions.filter((s) => s.state === "error").length,
          };
          result = summary;
        } else if (path === "/query" && req.method === "POST") {
          const q = JSON.parse(body);
          const sessions = allSessions();
          result = sessions.filter((s) => {
            if (q.state && s.state !== q.state) return false;
            if (q.harness && s.harnessId !== q.harness) return false;
            if (q.cwd && !s.cwd?.includes(q.cwd)) return false;
            return true;
          });
        } else {
          res.writeHead(404).end(JSON.stringify({ error: "not found" }));
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: e.message }));
      }
    });
  });

  cliServer.on("error", (err) => {
    // The CLI is a convenience endpoint — never let it take the daemon down
    // (e.g. another instance already owns the port).
    console.warn(`  cli       unavailable: ${err.message}`);
  });

  cliServer.listen(port, "127.0.0.1", () => {
    toolApproval.init(port);
    console.log(`  cli       http://127.0.0.1:${port}`);
  });
}

export function stop() {
  if (cliServer) cliServer.close();
}
