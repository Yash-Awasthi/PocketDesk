// Per-device tokens, real revocation, and share-token spectators.
import { check, connect, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-auth-");

const PORT = 8833;
const CLI_PORT = 46833;
const TOKEN = "authtoken";

async function hello(msg) {
  const c = connect(PORT, TOKEN);
  await new Promise((res, rej) => { c.ws.on("open", res); c.ws.on("error", rej); });
  const closed = new Promise((res) => c.ws.once("close", (code) => res(code)));
  c.send({ type: "hello", ...msg });
  const first = await Promise.race([c.next((m) => m.type === "welcome" || m.type === "share_joined"), closed]);
  return { c, first, closed };
}

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, dataDir: ".pocketdesk-authtest" });
  await d.ready;
  const admin = await openAndHello(PORT, TOKEN);

  const phone = await hello({ token: TOKEN, name: "phone" });
  const deviceToken = phone.first.deviceToken;
  check("pairing with the master token issues a device token", typeof deviceToken === "string" && deviceToken.length > 20);
  check("device id is server-assigned", typeof phone.first.clientId === "string" && phone.first.clientId.length > 20);
  await phone.c.close();

  const again = await hello({ token: deviceToken });
  check("device token authenticates as the same device", again.first.clientId === phone.first.clientId && !again.first.deviceToken);

  admin.send({ type: "device_revoke", clientId: phone.first.clientId });
  const rev = await admin.next((m) => m.type === "device_revoked");
  check("revoke acks with a fresh pairing token", rev.ok === true && typeof rev.pairingToken === "string" && rev.pairingToken !== TOKEN);
  check("revoked device's live socket is closed", (await again.closed) === 4003);

  const byDevice = await hello({ token: deviceToken });
  check("revoked device token is refused", byDevice.first === 4003);
  const byOldMaster = await hello({ token: TOKEN });
  check("old master token is refused after revoke", byOldMaster.first === 4003);
  const byNewMaster = await hello({ token: rev.pairingToken });
  check("new master token pairs", byNewMaster.first.type === "welcome");
  await byNewMaster.c.close();

  // Share token: a spectator logs in with it and is pinned to one session.
  admin.send({ type: "create", harness: "node", cwd: tmp });
  const s = await admin.next((m) => m.type === "created");
  admin.send({ type: "create", harness: "node", cwd: tmp });
  const other = await admin.next((m) => m.type === "created" && m.id !== s.id);
  admin.send({ type: "share_create", id: s.id, mode: "readwrite" });
  const share = await admin.next((m) => m.type === "share_created");

  const viewer = await hello({ share: share.token });
  check("share token logs in to its session", viewer.first.type === "share_joined" && viewer.first.sessionId === s.id);
  viewer.c.send({ type: "attach", id: other.id });
  check("spectator cannot attach another session", /not allowed/.test((await viewer.c.next((m) => m.type === "error")).message));
  viewer.c.send({ type: "fs", path: "." });
  check("spectator cannot browse files", /not allowed/.test((await viewer.c.next((m) => m.type === "error")).message));
  const seen = [];
  viewer.c.ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
  admin.send({ type: "create", harness: "node", cwd: tmp });
  await admin.next((m) => m.type === "created" && m.id !== s.id && m.id !== other.id);
  await new Promise((r) => setTimeout(r, 500));
  check("spectator does not receive the session list broadcast", !seen.some((m) => m.type === "sessions"));
  admin.send({ type: "constructor" });
  check("prototype names are not handler types", /unknown type/.test((await admin.next((m) => m.type === "error")).message));
  const bad = await hello({ share: "nope" });
  check("unknown share token is refused", bad.first === 4003);

  await admin.close();
  await viewer.c.close();
}

main()
  .catch((e) => check(`auth test crashed: ${e.message}`, false))
  .finally(async () => {
    await teardown(tmp);
    finish();
  });
