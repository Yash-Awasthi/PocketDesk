// Without TLS the token would cross the LAN in the clear, so a plaintext daemon must refuse
// every connection that does not come from this machine.
import os from "node:os";
import path from "node:path";
import { check, finish, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8861;
const CLI_PORT = 46861;
const TOKEN = "plaintoken";
const home = path.join(os.tmpdir(), "rh-home-" + PORT);

const lan = Object.values(os.networkInterfaces()).flat().find((ni) => ni?.family === "IPv4" && !ni.internal)?.address;
const fetchCode = (host) => fetch(`http://${host}:${PORT}/health`).then((r) => r.status).catch(() => 0);

const d = startDaemon(PORT, CLI_PORT, { token: TOKEN });
await d.ready;
try {
  check("loopback HTTP is served", (await fetchCode("127.0.0.1")) === 200);
  const c = await openAndHello(PORT, TOKEN);
  check("loopback websocket authenticates", true);
  await c.close();
  if (lan) check(`LAN address ${lan} is refused`, (await fetchCode(lan)) === 0);
  else console.log("SKIP  no non-loopback IPv4 address on this machine");
} finally {
  await teardown(home);
}
finish();
