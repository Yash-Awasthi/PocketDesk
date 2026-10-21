// With TLS on, the PC's own browser gets the page over plain HTTP on loopback (port + 10): a secure
// context without a certificate warning, while phones keep the pinned TLS port.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { check, finish, makeTmp, teardown } from "./helpers.mjs";

const PORT = 8877;
const home = makeTmp("rh-local-");
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, iroh: { enabled: false } }));

const d = spawn(process.execPath, ["src/index.js"], {
  env: { ...process.env, RH_HOME: home, RH_CLI_PORT: "46877", RH_PORT: undefined, RH_TOKEN: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((resolve, reject) => {
    d.stdout.on("data", (x) => { if (/websocket/.test(String(x))) resolve(); });
    setTimeout(() => reject(new Error("daemon did not start")), 30000);
  });
  await new Promise((r) => setTimeout(r, 500));
  const { token, tls } = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  check("the daemon made its own certificate", tls.enabled === true);

  const page = await fetch(`http://127.0.0.1:${PORT + 10}/`).then((r) => r.text()).catch((e) => e.message);
  check("the browser page is served over loopback HTTP", /PocketDesk Phone/.test(page));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT + 10}/ws`, { headers: { origin: `http://localhost:${PORT + 10}` } });
  const welcome = await new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, name: "PC browser" })));
    ws.on("message", (m) => { const o = JSON.parse(m); if (o.type === "welcome") resolve(o); });
    ws.on("error", () => resolve(null));
    setTimeout(() => resolve(null), 8000);
  });
  check("its socket logs in like the TLS one", !!welcome);
  ws.close();

  const proof = await fetch(`http://127.0.0.1:${PORT + 10}/prove?n=abc`).then((r) => r.text());
  check("the page port proves it holds the token", proof === crypto.createHmac("sha256", token).update("abc").digest("hex"));

  const plain = await fetch(`http://127.0.0.1:${PORT}/`).then(() => "answered").catch(() => "refused");
  check("the phone port stays TLS-only", plain === "refused");
} catch (e) {
  check("local page flow: " + e.message, false);
} finally {
  d.kill();
  await teardown(home);
}
finish();
