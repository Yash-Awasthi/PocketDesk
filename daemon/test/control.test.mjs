// PC power actions over the socket, and two-factor pairing from the local settings page.
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

  const post = (p, body = {}) => fetch(`http://127.0.0.1:${PORT}/access/totp/${p}?k=${TOKEN}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  check("two-factor setup needs the settings key", (await fetch(`http://127.0.0.1:${PORT}/access/totp/setup`, { method: "POST" })).status === 403);
  const { secret } = await post("setup");
  check("two-factor refuses a wrong code", (await post("enable", { code: "000000" })).ok === false);
  check("two-factor turns on with a valid code", (await post("enable", { code: code(secret, step() - 1) })).totpEnabled === true);
  check("pairing with the master token alone is refused with 4011", (await hello({})) === 4011);
  check("pairing with a code is accepted", (await hello({ totp: code(secret, step()) })) === "welcome");
  check("two-factor turns off with a code", (await post("disable", { code: code(secret, step() + 1) })).totpEnabled === false);
  await c.close();
} catch (e) {
  check("control flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
