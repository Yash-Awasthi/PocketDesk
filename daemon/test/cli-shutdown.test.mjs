// Installers run unelevated and cannot kill an elevated daemon, so they ask it to stop over the
// loopback CLI port; only the master token may.
import os from "node:os";
import path from "node:path";
import { check, finish, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8863;
const CLI_PORT = 46863;
const TOKEN = "shutdowntoken";
const home = path.join(os.tmpdir(), "rh-home-" + PORT);
const stop = (token) => fetch(`http://127.0.0.1:${CLI_PORT}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
  .then((r) => r.status).catch(() => 0);

const d = startDaemon(PORT, CLI_PORT, { token: TOKEN });
await d.ready;
try {
  const exited = new Promise((r) => d.once("exit", (code) => r(code)));
  check("shutdown refuses a wrong token", (await stop("nope")) === 401);
  check("daemon still answers after a refused shutdown", (await fetch(`http://127.0.0.1:${PORT}/health`)).status === 200);
  check("shutdown with the master token is accepted", (await stop(TOKEN)) === 200);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
  check("daemon exits cleanly after shutdown", code === 0);
} finally {
  await teardown(home);
}
finish();
