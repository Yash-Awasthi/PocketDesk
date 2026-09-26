import http from "node:http";
import crypto from "node:crypto";
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";
import * as toolApproval from "./tool_approval.js";

function allSessions() {
  return [...sessions.summary(), ...chat.summary()];
}

let cliServer = null;

export function start(getToken, port = Number(process.env.RH_CLI_PORT) || 4679) {
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

        if (path === "/sessions") {
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
