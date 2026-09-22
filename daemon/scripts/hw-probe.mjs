/**
 * Real-hardware probe for the SSH, SFTP and VNC transports. The automated
 * suite only ever meets loopback and fakes; this drives the same daemon
 * modules against a machine you actually own.
 *
 *   node scripts/hw-probe.mjs --host 192.168.1.20 --user dev --key ~/.ssh/id_ed25519
 *   node scripts/hw-probe.mjs --host 192.168.1.20 --user dev --password secret
 *   node scripts/hw-probe.mjs --vnc-host 192.168.1.30 --vnc-password secret
 *
 * SSH and VNC halves are independent: give either, or both.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MultiProtocolClient } from "../src/ssh_vnc_client.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

let failures = 0;
const pass = (name, detail = "") => console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, err) => { failures++; console.log(`FAIL  ${name} — ${err?.message ?? err}`); };
async function step(name, fn) {
  try { return await fn(); } catch (e) { fail(name, e); return null; }
}

const mpc = new MultiProtocolClient();
mpc.on("hostkey:new", (e) => console.log(`      host key trusted on first sight: ${e.host}:${e.port} ${e.fingerprint}`));
mpc.on("hostkey:changed", (e) => console.log(`      HOST KEY CHANGED: ${e.host}:${e.port} was ${e.oldFingerprint} now ${e.newFingerprint}`));

async function probeSSH() {
  const host = args.host;
  if (!host) return;
  if (!args.user) return fail("ssh", new Error("--user is required with --host"));
  if (!args.key && !args.password) return fail("ssh", new Error("give --key or --password"));

  let keyId;
  if (args.key) {
    const privatePath = args.key.startsWith("~") ? path.join(os.homedir(), args.key.slice(1)) : args.key;
    if (!fs.existsSync(privatePath)) return fail("ssh", new Error(`no private key at ${privatePath}`));
    // The key store is normally filled by sshkey_generate; point it at an
    // existing key so the probe exercises the real key-auth path.
    keyId = crypto.randomUUID();
    mpc.sshKeys.set(keyId, { id: keyId, name: path.basename(privatePath), type: "imported", privatePath });
  }

  const profile = mpc.createProfile({
    name: "probe", host, port: Number(args.port) || 22, username: args.user,
    protocols: ["ssh", "sftp"], authMethod: keyId ? "key" : "password", keyId,
  });
  const opts = keyId ? { passphrase: args.passphrase } : { password: args.password };

  const ssh = await step("ssh connect", () => mpc.connectSSH(profile.id, opts));
  if (!ssh) return;
  pass("ssh connect", `${host} — host key ${ssh.hostKey.status}${ssh.hostKey.isNew ? " (first sight)" : ""}`);

  const out = await step("ssh exec", () => mpc.exec(ssh.id, "uname -a || ver"));
  if (out) pass("ssh exec", out.stdout.trim().split("\n")[0] || `exit ${out.code}`);

  const sftp = await step("sftp connect", () => mpc.connectSFTP(profile.id, opts));
  if (sftp) {
    pass("sftp connect", `remote cwd ${sftp.currentDir}`);
    const payload = crypto.randomBytes(64 * 1024);
    const localUp = path.join(os.tmpdir(), `rh-probe-up-${Date.now()}`);
    const localDown = `${localUp}-back`;
    const remote = `${sftp.currentDir.replace(/\/$/, "")}/rh-probe-${Date.now()}`;
    fs.writeFileSync(localUp, payload);
    const round = await step("sftp round trip", async () => {
      await mpc.uploadFile(sftp.id, localUp, remote);
      await mpc.downloadFile(sftp.id, remote, localDown);
      return fs.readFileSync(localDown);
    });
    if (round) {
      if (round.equals(payload)) pass("sftp round trip", `${payload.length} bytes up and back, byte-identical`);
      else fail("sftp round trip", new Error(`got ${round.length} bytes, expected ${payload.length}`));
    }
    await step("sftp cleanup", () => new Promise((res) => sftp.sftp.unlink(remote, () => res(true))));
    for (const f of [localUp, localDown]) { try { fs.unlinkSync(f); } catch {} }
    await mpc.disconnectSFTP(sftp.id);
  }
  await mpc.disconnectSSH(ssh.id);
}

async function probeVNC() {
  const host = args["vnc-host"] || (args["vnc-port"] ? args.host : null);
  if (!host) return;
  const profile = mpc.createProfile({ name: "probe-vnc", host, username: args.user || "vnc", protocols: ["vnc"] });
  const vnc = await step("vnc connect", () => mpc.connectVNC(profile.id, {
    port: Number(args["vnc-port"]) || 5900,
    password: args["vnc-password"],
  }));
  if (!vnc) return;
  pass("vnc connect", `${vnc.width}x${vnc.height} @ ${vnc.bitsPerPixel}bpp — "${vnc.desktopName}"`);
  await mpc.disconnectVNC(vnc.id);
}

await probeSSH();
await probeVNC();
mpc.dispose();

if (!args.host && !args["vnc-host"]) {
  console.log("nothing to probe — pass --host (ssh/sftp) and/or --vnc-host (vnc). See the header of this file.");
  process.exit(2);
}
console.log(failures ? `\n${failures} step(s) failed.` : "\nAll probe steps passed.");
process.exit(failures ? 1 : 0);
