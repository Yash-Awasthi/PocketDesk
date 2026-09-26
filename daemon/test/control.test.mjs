// Two-factor pairing and PC power actions over the socket.
import { check, connect, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import { code } from "../src/totp.js";

const PORT = 8853;
const CLI_PORT = 46853;
const TOKEN = "controltoken";
const tmp = makeTmp("rh-control-");
const step = () => Math.floor(Date.now() / 30000);

/** Resolves the close code, or "welcome" when the hello was accepted. */
function hello(extra) {
  return new Promise((resolve) => {
    const c = connect(PORT, TOKEN);
    c.ws.on("open", () => c.send({ type: "hello", token: TOKEN, ...extra }));
    c.ws.on("close", (code) => resolve(code));
    c.next((m) => m.type === "welcome").then(() => { resolve("welcome"); c.close(); }, () => {});
  });
}

try {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, env: { RH_POWER_DRY: "1" } });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({ type: "pc_power", action: "lock" });
  const lock = await c.next((m) => m.type === "pc_power");
  check("lock is a known power action", lock.ok && lock.action === "lock");
  c.send({ type: "pc_power", action: "format-disk" });
  check("unknown power actions are refused", !(await c.next((m) => m.type === "pc_power")).ok);

  c.send({ type: "totp_setup" });
  const { secret } = await c.next((m) => m.type === "totp_setup");
  c.send({ type: "totp_enable", code: code(secret, step() - 1) });
  check("two-factor turns on with a valid code", (await c.next((m) => m.type === "totp_status")).enabled === true);
  check("pairing with the master token alone is refused with 4011", (await hello({})) === 4011);
  check("pairing with a code is accepted", (await hello({ totp: code(secret, step()) })) === "welcome");
  c.send({ type: "totp_disable", code: code(secret, step() + 1) });
  check("two-factor turns off with a code", (await c.next((m) => m.type === "totp_status")).enabled === false);
  await c.close();
} catch (e) {
  check("control flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
