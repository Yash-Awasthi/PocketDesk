// SSH tab backing surface — the exact messages the browser client's Profiles,
// Keys, Known-hosts and Servers sections send, checked against a live daemon.
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-sshui-");

const PORT = 8832;
const CLI_PORT = 46832;
const TOKEN = "sshuitoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Keys panel: generate → list → select in the profile form.
  c.send({ type: "sshkey_generate", algo: "ed25519", name: "panel key" });
  const gen = await c.next((m) => m.type === "sshkey_generated");
  check("sshkey_generate returns a public key the panel can paste", gen.ok === true
    && /^ssh-ed25519 /.test(gen.key.publicKey) && /^SHA256:/.test(gen.key.fingerprint));

  c.send({ type: "sshkey_list" });
  const keys = await c.next((m) => m.type === "sshkey_list");
  check("sshkey_list feeds the key dropdown", keys.items.some((k) => k.id === gen.key.id && k.name === "panel key"));

  // Profiles panel: the form's key selection must survive onto the profile —
  // without it the panel can only ever do password auth.
  c.send({ type: "profile_create", name: "box", host: "10.0.0.9", port: 2200, username: "dev", protocols: ["ssh", "sftp", "vnc"], authMethod: "key", keyId: gen.key.id });
  const made = await c.next((m) => m.type === "profile_created");
  check("profile_create keeps the selected key", made.ok === true && made.profile.keyId === gen.key.id);

  c.send({ type: "profile_list" });
  const profiles = await c.next((m) => m.type === "profile_list");
  check("profile_list renders the row", profiles.items.some((p) => p.id === made.profile.id && p.host === "10.0.0.9" && p.port === 2200));

  // Connect button on an unreachable host: the panel shows the error, not a hang.
  c.send({ type: "profile_connect", id: made.profile.id, protocol: "ssh", timeoutMs: 1500 });
  const conn = await c.next((m) => m.type === "profile_connected", 20000);
  check("profile_connect reports failure instead of hanging", conn.ok === false && typeof conn.error === "string");

  // Known-hosts panel + the banner it raises.
  c.send({ type: "hostkey_verify", host: "10.0.0.9", port: 2200, fingerprint: "SHA256:aaa", keyType: "ssh-ed25519" });
  const first = await c.next((m) => m.type === "hostkey_verify");
  check("first sight of a host key is trusted", first.status === "accepted" && first.isNew === true);

  c.send({ type: "hostkey_verify", host: "10.0.0.9", port: 2200, fingerprint: "SHA256:bbb", keyType: "ssh-ed25519" });
  const changed = await c.next((m) => m.type === "hostkey_verify");
  check("a changed host key is refused", changed.status === "changed" && changed.oldFingerprint === "SHA256:aaa");

  c.send({ type: "hostkey_list" });
  const hosts = await c.next((m) => m.type === "hostkey_list");
  check("hostkey_list shows the known host", hosts.items.some((h) => h.keyId === "10.0.0.9:2200"));

  c.send({ type: "mproto_status" });
  const status = await c.next((m) => m.type === "mproto_status");
  check("mproto_status feeds the header line", status.profiles === 1 && status.sshKeys >= 1 && status.hostKeys >= 1);

  // Servers panel: start/stats/stop on loopback for both listeners.
  for (const [kind, port] of [["bastion", 22231], ["sshserver", 22232]]) {
    c.send({ type: `${kind}_start`, port, host: "127.0.0.1" });
    const up = await c.next((m) => m.type === `${kind}_started`);
    check(`${kind}_start binds loopback`, up.ok === true && up.port === port);

    c.send({ type: `${kind}_stats` });
    const stats = await c.next((m) => m.type === `${kind}_stats`);
    check(`${kind}_stats reports running`, stats.running === true && stats.port === port);

    c.send({ type: `${kind}_stop` });
    const down = await c.next((m) => m.type === `${kind}_stopped`);
    check(`${kind}_stop releases the port`, down.ok === true);

    c.send({ type: `${kind}_stats` });
    const after = await c.next((m) => m.type === `${kind}_stats`);
    check(`${kind}_stats reports stopped`, after.running === false);
  }

  c.send({ type: "sshkey_delete", id: gen.key.id });
  check("sshkey_delete answers", (await c.next((m) => m.type === "sshkey_deleted")).ok === true);

  c.send({ type: "profile_delete", id: made.profile.id });
  check("profile_delete answers", (await c.next((m) => m.type === "profile_deleted")).ok === true);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
