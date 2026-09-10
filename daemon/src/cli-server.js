import http from "node:http";
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";

function allSessions() {
  return [...sessions.summary(), ...chat.summary()];
}

let cliServer = null;

export function start(port = Number(process.env.RH_CLI_PORT) || 4679) {
  cliServer = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405).end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (d) => (body += d));
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
    console.log(`  cli       http://127.0.0.1:${port}`);
  });
}

export function stop() {
  if (cliServer) cliServer.close();
}
