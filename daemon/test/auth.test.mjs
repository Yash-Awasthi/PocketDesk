// Per-device tokens and real revocation.
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
  const first = await Promise.race([c.next((m) => m.type === "welcome"), closed]);
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

  const pairHtml = await fetch(`http://127.0.0.1:${PORT}/pair`).then((r) => r.text());
  const pairPayload = JSON.parse(Buffer.from(pairHtml.match(/pocketdesk:\/\/pair#([\w-]+)/)[1], "base64url").toString());
  check("pairing QR carries the rotated token", pairPayload.t === rev.pairingToken);
  const byDevice = await hello({ token: deviceToken });
  check("revoked device token is refused", byDevice.first === 4003);
  const byOldMaster = await hello({ token: TOKEN });
  check("old master token is refused after revoke", byOldMaster.first === 4003);
  const byNewMaster = await hello({ token: rev.pairingToken });
  check("new master token pairs", byNewMaster.first.type === "welcome");
  await byNewMaster.c.close();

  admin.send({ type: "constructor" });
  check("prototype names are not handler types", /unknown type/.test((await admin.next((m) => m.type === "error")).message));
  await admin.close();
}

main()
  .catch((e) => check(`auth test crashed: ${e.message}`, false))
  .finally(async () => {
    await teardown(tmp);
    finish();
  });
