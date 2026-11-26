// Credentials rotate on pairing and on revoke, and a superseded one stops working on the
// very next message of a socket that is already open — not only at the next hello.
import { check, connect, finish, makeTmp, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-tokenrotation-");
const PORT = 8884;
const CLI_PORT = 46884;
const TOKEN = "rotationtoken";

const base = `http://127.0.0.1:${PORT}`;
const post = (p, key, body = {}) =>
  fetch(`${base}${p}?k=${key}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

/** The master token as the owner's own browser learns it: the loopback page meta. */
async function masterToken() {
  const html = await fetch(`${base}/`).then((r) => r.text());
  const m = html.match(/<meta name="pd-token" content="([^"]+)">/);
  return m ? m[1] : null;
}

/** Resolve { c, first, closed }; `first` is the welcome object or the close code. */
function hello(msg) {
  const c = connect(PORT, TOKEN);
  const closed = new Promise((res) => c.ws.once("close", (code) => res(code)));
  c.ws.on("open", () => c.send({ type: "hello", ...msg }));
  return new Promise((resolve) => {
    Promise.race([c.next((m) => m.type === "welcome", 15000), closed]).then((first) =>
      resolve({ c, first, closed }),
    );
  });
}

/** Same socket shape, but the handshake must succeed. */
async function open(msg) {
  const h = await hello(msg);
  if (h.first?.type !== "welcome") throw new Error(`hello refused with ${JSON.stringify(h.first)}`);
  return h;
}

function timeout(ms, what) {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms);
    t.unref?.();
  });
}

async function main() {
  const d = startDaemon(PORT, CLI_PORT, {
    token: TOKEN,
    manifests: tmp,
    dataDir: ".pocketdesk-tokenrotation",
  });
  await d.ready;

  const m0 = await masterToken();
  check("loopback page carries the master token", m0 === TOKEN);

  // Pair a device with the master token.
  const first = await open({ token: m0, name: "phone" });
  const idA = first.first.clientId;
  const tokA1 = first.first.deviceToken;
  check("pairing issues a fresh device token", typeof tokA1 === "string" && tokA1.length > 20);

  // Revoke rotates the pairing token: the old master dies at the next hello.
  const revA = await post("/access/devices/revoke", m0, { clientId: idA });
  check(
    "revoke acks with a rotated pairing token",
    revA.ok === true && typeof revA.pairingToken === "string" && revA.pairingToken !== m0,
  );
  const m1 = await masterToken();
  check("the page meta carries the rotated master token", m1 === revA.pairingToken && m1 !== m0);
  const oldMasterHello = await hello({ token: m0 });
  check("the old master is refused 4003 at the next hello", oldMasterHello.first === 4003);
  await oldMasterHello.c.close();

  // Allow, then pair the same identity again: it gets a different device token.
  const allowed = await post("/access/devices/allow", m1, { clientId: idA });
  check("a revoked device can be allowed again", allowed.ok === true);
  const second = await open({ token: m1, clientId: idA, name: "phone" });
  const tokA2 = second.first.deviceToken;
  check("second pairing of the same device keeps its identity", second.first.clientId === idA);
  check("second pairing issues a different device token", typeof tokA2 === "string" && tokA2 !== tokA1);
  const superseded = await hello({ token: tokA1 });
  check("the superseded device token is refused 4003 at the next hello", superseded.first === 4003);
  await superseded.c.close();

  // A second device pairs, so revoking A leaves B's live socket alone.
  const devB = await open({ token: m1, name: "tablet" });
  const idB = devB.first.clientId;
  const tokB = devB.first.deviceToken;
  check("a second device pairs while the master token is unchanged", typeof tokB === "string" && idB !== idA);

  // Live sockets opened before the rotation.
  const liveA = await open({ token: tokA2 });
  const liveB = await open({ token: tokB });
  const liveMaster = await open({ token: m1 });
  const liveAClosed = liveA.closed;
  const liveMasterClosed = liveMaster.closed;

  // Revoke A: bumps A's generation, closes A's socket, and rotates the master.
  const revA2 = await post("/access/devices/revoke", m1, { clientId: idA });
  check("second revoke rotates the master again", revA2.ok === true && revA2.pairingToken !== m1);
  const m2 = await masterToken();
  check("the page meta follows the second rotation", m2 === revA2.pairingToken && m2 !== m1);

  check(
    "a revoked device's live socket is closed 4003",
    (await Promise.race([liveAClosed, timeout(8000, "revoked device close")])) === 4003,
  );

  liveMaster.c.send({ type: "stats" });
  check(
    "a live socket holding the old master is closed 4003 on its next message",
    (await Promise.race([liveMasterClosed, timeout(8000, "stale master close")])) === 4003,
  );

  liveB.c.send({ type: "stream_stats" });
  const stats = await liveB.c.next((m) => m.type === "stream_stats", 8000);
  check("a device-token socket survives a master rotation", stats.type === "stream_stats");

  const oldMasterAgain = await hello({ token: m1 });
  check("the first master is still refused after a second rotation", oldMasterAgain.first === 4003);
  await oldMasterAgain.c.close();
  const newMaster = await open({ token: m2 });
  check("the current master pairs again after the rotation", newMaster.first.type === "welcome");
  await newMaster.c.close();

  await liveB.c.close();
  await second.c.close();
  await first.c.close();
  await devB.c.close();
}

main()
  .catch((e) => check(`token rotation test crashed: ${e.message}`, false))
  .finally(async () => {
    await teardown(tmp);
    finish();
  });
