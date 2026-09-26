// Console (SYSTEM) endpoint: single-use master token and the audit log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, connect, finish, makeTmp, startDaemon, teardown } from "./helpers.mjs";

// RH_CONSOLE locks RH_HOME to Administrators + SYSTEM, which an unelevated Windows shell cannot then read.
if (process.platform === "win32" && spawnSync("net", ["session"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIP  console endpoint checks need an elevated shell on Windows (CI covers them on Linux)");
  process.exit(0);
}

const tmp = makeTmp("rh-console-");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-console-home-"));
const PORT = 8841;
const CLI_PORT = 46841;
const TOKEN = "consoletoken";

async function hello(token) {
  const c = connect(PORT, token);
  await new Promise((res, rej) => { c.ws.on("open", res); c.ws.on("error", rej); });
  const closed = new Promise((res) => c.ws.once("close", (code) => res(code)));
  c.send({ type: "hello", token, name: "phone" });
  const first = await Promise.race([c.next((m) => m.type === "welcome"), closed]);
  return { c, first };
}

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, home, dataDir: ".pocketdesk-consoletest", env: { RH_CONSOLE: "1" } });
  await d.ready;

  const phone = await hello(TOKEN);
  const deviceToken = phone.first.deviceToken;
  check("console pairing issues a device token", typeof deviceToken === "string");
  const again = await hello(TOKEN);
  check("console master token stops working after one pairing", again.first === 4003);
  const byDevice = await hello(deviceToken);
  check("paired device keeps working", byDevice.first?.type === "welcome");

  byDevice.c.send({ type: "fs", path: os.tmpdir() });
  await byDevice.c.next((m) => m.type === "fs");
  byDevice.c.send({ type: "desktop_ping" });
  byDevice.c.send({ type: "stats" });
  await byDevice.c.next((m) => m.type === "stats");
  const lines = fs.readFileSync(path.join(home, "console-audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("console actions are audited with device and path", lines.some((l) => l.type === "fs" && l.device === byDevice.first.clientId && l.path === os.tmpdir()));
  check("high-rate traffic stays out of the audit log", !lines.some((l) => l.type === "desktop_ping"));

  await phone.c.close();
  await byDevice.c.close();
  await teardown(tmp);
  fs.rmSync(home, { recursive: true, force: true });
  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
