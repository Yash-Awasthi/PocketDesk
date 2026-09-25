// SSH bastion + advanced SSH server + multi-protocol client: the protocol
// surfaces from sshportal/bifroest/cardea (ssh_bastion, advanced_ssh_server)
// and haven-ssh-client (ssh_vnc_client). In-memory and deterministic.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import ssh2 from "ssh2";

const IS_WIN = process.platform === "win32";
const tmp = makeTmp("rh-t-");

const PORT = 8826;
const CLI_PORT = 46826;
const TOKEN = "bastiontoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // ── SSH bastion (sshportal/bifroest/cardea: users, hosts, access rules) ─
  c.send({ type: "bastion_user_add", username: "alice", publicKey: "ssh-ed25519 AAAA", accessLevel: "admin" });
  const bu = await c.next((m) => m.type === "bastion_user_added");
  check("bastion user registered", bu.ok === true && bu.user.username === "alice");
  const aliceId = bu.user.id;

  c.send({ type: "bastion_host_add", name: "web", hostname: "10.0.0.5", port: 22, username: "root", group: "prod" });
  const bh = await c.next((m) => m.type === "bastion_host_added");
  check("bastion host registered", bh.ok === true && bh.host.name === "web");
  const hostId = bh.host.id;

  // Denied by default.
  c.send({ type: "bastion_access", userId: aliceId, hostId });
  const denied = await c.next((m) => m.type === "bastion_access");
  check("access denied without rule", denied.allowed === false);

  c.send({ type: "bastion_rule_add", userId: aliceId, hostId, accessLevel: "admin", allowed: true });
  await c.next((m) => m.type === "bastion_rule_added");
  c.send({ type: "bastion_access", userId: aliceId, hostId });
  const granted = await c.next((m) => m.type === "bastion_access");
  check("access granted by rule", granted.allowed === true);

  c.send({ type: "bastion_session_start", userId: aliceId, hostId, clientIp: "10.0.0.99" });
  const bs = await c.next((m) => m.type === "bastion_session_started");
  check("bastion session starts", bs.ok === true && !!bs.session.id);
  const bsEvt = await c.next((m) => m.type === "bastion_event" && m.bastionEvent === "started");
  check("bastion session event broadcast", bsEvt.id === bs.session.id);

  c.send({ type: "bastion_sessions" });
  const sess = await c.next((m) => m.type === "bastion_sessions");
  check("bastion_sessions lists active", sess.items.length === 1);

  c.send({ type: "bastion_stats" });
  const bstats = await c.next((m) => m.type === "bastion_stats");
  check("bastion stats count", bstats.totalUsers === 1 && bstats.totalHosts === 1 && bstats.activeSessions === 1);

  c.send({ type: "bastion_session_end", sessionId: bs.session.id });
  const be = await c.next((m) => m.type === "bastion_session_ended");
  check("bastion session ends", be.ok === true);

  c.send({ type: "bastion_session_start", userId: "nope", hostId, clientIp: "x" });
  const badStart = await c.next((m) => m.type === "bastion_session_started");
  check("unknown user cannot start session", badStart.ok === false);

  // ── Advanced SSH server (bifroest/sshwifty: auth + command control) ─────
  c.send({ type: "sshserver_user_add", username: "bob", allowedCommands: ["git", "ls"], maxSessions: 2 });
  const su = await c.next((m) => m.type === "sshserver_user_added");
  check("sshserver user registered", su.ok === true && su.user.username === "bob");

  c.send({ type: "sshserver_session_create", username: "bob", clientIp: "192.168.1.7", method: "token" });
  const ss = await c.next((m) => m.type === "sshserver_session_created");
  check("sshserver session created", ss.ok === true && !!ss.session.id);

  // A user WITH a credential must present it. The old authenticate() ended in
  // `return true`, so claiming an unconfigured method walked straight past a
  // configured password hash — and nothing called authenticate() at all.
  c.send({ type: "sshserver_user_add", username: "carol", password: "hunter2", allowedCommands: ["ls"] });
  await c.next((m) => m.type === "sshserver_user_added");

  c.send({ type: "sshserver_session_create", username: "carol", method: "publickey" });
  const bypass = await c.next((m) => m.type === "sshserver_session_created");
  check("credentialed user cannot be bypassed by claiming another method", bypass.ok === false);

  c.send({ type: "sshserver_session_create", username: "carol", method: "password", credential: "wrong" });
  const badPw = await c.next((m) => m.type === "sshserver_session_created");
  check("wrong password rejected", badPw.ok === false);

  c.send({ type: "sshserver_session_create", username: "carol", method: "password", credential: "hunter2" });
  const goodPw = await c.next((m) => m.type === "sshserver_session_created");
  check("correct password accepted", goodPw.ok === true && !!goodPw.session.id);
  c.send({ type: "sshserver_session_end", sessionId: goodPw.session.id });
  await c.next((m) => m.type === "sshserver_session_ended");

  c.send({ type: "sshserver_user_list" });
  const users = await c.next((m) => m.type === "sshserver_user_list");
  check("user list never leaks passwordHash", users.items.every((u) => !("passwordHash" in u)));

  c.send({ type: "sshserver_exec", sessionId: ss.session.id, command: "git status" });
  const okExec = await c.next((m) => m.type === "sshserver_exec_ok");
  check("allowlisted command executes", okExec.ok === true);
  const cmdEvt = await c.next((m) => m.type === "sshserver_event" && m.sshEvent === "executed");
  check("command event broadcast", cmdEvt.command === "git status");

  c.send({ type: "sshserver_exec", sessionId: ss.session.id, command: "rm -rf /" });
  const badExec = await c.next((m) => m.type === "sshserver_exec_ok");
  check("disallowed command rejected", badExec.ok === false);

  c.send({ type: "sshserver_stats" });
  const sstats = await c.next((m) => m.type === "sshserver_stats");
  check("sshserver stats count commands", sstats.activeSessions === 1 && sstats.totalCommands === 1);

  c.send({ type: "sshserver_session_end", sessionId: ss.session.id });
  const se = await c.next((m) => m.type === "sshserver_session_ended");
  check("sshserver session ends", se.ok === true);

  // ── Real SSH round trip: the daemon's own listener, dialled by its own client ─
  c.send({ type: "sshserver_start", port: 0, host: "127.0.0.1" });
  const srv = await c.next((m) => m.type === "sshserver_started", 20000);
  check("sshserver binds a real port", srv.ok === true && srv.port > 0);

  c.send({ type: "sshserver_user_add", username: "tester", password: "s3cret", allowedCommands: ["echo"] });
  await c.next((m) => m.type === "sshserver_user_added");

  c.send({ type: "profile_create", name: "loopback", host: "127.0.0.1", port: srv.port, username: "tester", protocols: ["ssh", "sftp"] });
  const pc = await c.next((m) => m.type === "profile_created");
  check("profile created", pc.ok === true && pc.profile.host === "127.0.0.1");
  const profileId = pc.profile.id;

  c.send({ type: "profile_connect", id: profileId, protocol: "ssh", password: "s3cret" });
  const conn = await c.next((m) => m.type === "profile_connected", 25000);
  check("profile connects over real SSH", conn.ok === true && conn.session.protocol === "ssh");
  check("host key recorded on first use", conn.session.hostKey?.status === "accepted" && conn.session.hostKey.isNew === true);
  check("no live handles on the wire", !("client" in conn.session) && !("channels" in conn.session));
  const connEvt = await c.next((m) => m.type === "mproto_event" && m.mprotoEvent === "connected");
  check("connect event broadcast", connEvt.profileId === profileId);

  c.send({ type: "sshserver_sessions" });
  const live = await c.next((m) => m.type === "sshserver_sessions");
  check("listener sees the authenticated session", live.items.some((x) => x.username === "tester"));

  c.send({ type: "profile_disconnect", sessionId: conn.session.id, protocol: "ssh" });
  const dc = await c.next((m) => m.type === "profile_disconnected");
  check("ssh disconnect acks", dc.ok === true);

  c.send({ type: "profile_connect", id: profileId, protocol: "ssh", password: "wrong" });
  const badPwConn = await c.next((m) => m.type === "profile_connected", 25000);
  check("wrong password refused by the real server", badPwConn.ok === false);

  c.send({ type: "sshserver_stop" });
  const srvStop = await c.next((m) => m.type === "sshserver_stopped");
  check("sshserver stops", srvStop.ok === true);

  c.send({ type: "profile_connect", id: "nope", protocol: "ssh" });
  const badConn = await c.next((m) => m.type === "profile_connected");
  check("unknown profile rejected", badConn.ok === false);

  c.send({ type: "hostkey_verify", host: "192.168.1.10", port: 22, fingerprint: "SHA256:abc", keyType: "ssh-ed25519" });
  const hk1 = await c.next((m) => m.type === "hostkey_verify");
  check("hostkey TOFU accepts new", hk1.status === "accepted" && hk1.isNew === true);

  c.send({ type: "hostkey_verify", host: "192.168.1.10", port: 22, fingerprint: "SHA256:abc", keyType: "ssh-ed25519" });
  const hk2 = await c.next((m) => m.type === "hostkey_verify");
  check("hostkey TOFU accepts known", hk2.status === "accepted" && hk2.isNew === false);

  c.send({ type: "hostkey_verify", host: "192.168.1.10", port: 22, fingerprint: "SHA256:DIFFERENT", keyType: "ssh-ed25519" });
  const hk3 = await c.next((m) => m.type === "hostkey_verify");
  check("hostkey change flagged", hk3.status === "changed" && hk3.oldFingerprint === "SHA256:abc");

  c.send({ type: "sshkey_generate", algo: "ed25519", name: "phone" });
  const kg = await c.next((m) => m.type === "sshkey_generated");
  check("ssh key generated", kg.ok === true && kg.key.name === "phone");

  c.send({ type: "sshkey_list" });
  const kl = await c.next((m) => m.type === "sshkey_list");
  check("sshkey_list shows key", kl.items.length === 1);

  c.send({ type: "mproto_status" });
  const ms = await c.next((m) => m.type === "mproto_status");
  // Two host keys: the real loopback connect plus the hostkey_verify above.
  check("mproto_status counts", ms.profiles === 1 && ms.hostKeys === 2 && ms.sshKeys === 1);

  c.send({ type: "profile_list" });
  const pl = await c.next((m) => m.type === "profile_list");
  check("profile_list round-trips", pl.items.length === 1 && pl.items[0].id === profileId);

  c.send({ type: "sshkey_delete", id: kg.key.id });
  const kd = await c.next((m) => m.type === "sshkey_deleted");
  check("sshkey_delete acks", kd.ok === true);

  // ── Real jump host: client → bastion → target SSH server ───────────────
  c.send({ type: "sshserver_start", port: 0, host: "127.0.0.1" });
  const target = await c.next((m) => m.type === "sshserver_started", 20000);
  check("target SSH server binds", target.ok === true && target.port > 0);

  c.send({ type: "sshserver_user_add", username: "jumped", password: "tpw" });
  await c.next((m) => m.type === "sshserver_user_added");

  const pair = ssh2.utils.generateKeyPairSync("ed25519");
  c.send({ type: "bastion_user_add", username: "alice2", publicKey: pair.public, accessLevel: "admin" });
  const ju = await c.next((m) => m.type === "bastion_user_added");

  c.send({ type: "bastion_host_add", name: "target", hostname: "127.0.0.1", port: target.port, username: "jumped", password: "tpw" });
  const jh = await c.next((m) => m.type === "bastion_host_added");
  check("host credentials never returned", !("credentials" in jh.host));

  c.send({ type: "bastion_rule_add", userId: ju.user.id, hostId: jh.host.id, accessLevel: "admin", allowed: true });
  await c.next((m) => m.type === "bastion_rule_added");

  c.send({ type: "bastion_start", port: 0, host: "127.0.0.1" });
  const bsrv = await c.next((m) => m.type === "bastion_started", 20000);
  check("bastion binds a real port", bsrv.ok === true && bsrv.port > 0);

  // `alice2@target` is the sshportal login convention: bastion user @ host name.
  const jumpOut = await new Promise((resolve, reject) => {
    const cl = new ssh2.Client();
    const timer = setTimeout(() => { cl.end(); reject(new Error("jump timeout")); }, 30000);
    cl.on("ready", () => {
      cl.exec("echo hi", (err, stream) => {
        if (err) { clearTimeout(timer); cl.end(); return reject(err); }
        let out = "";
        stream.on("data", (d) => { out += d; });
        stream.on("close", () => { clearTimeout(timer); cl.end(); resolve(out); });
      });
    });
    cl.on("error", (err) => { clearTimeout(timer); reject(err); });
    cl.connect({ host: "127.0.0.1", port: bsrv.port, username: "alice2@target", privateKey: pair.private });
  });
  check("command runs on the target through the bastion", /hi/.test(jumpOut));

  c.send({ type: "bastion_sessions" });
  const jsess = await c.next((m) => m.type === "bastion_sessions");
  const proxied = jsess.items.find((x) => x.hostId === jh.host.id) || jsess.items[0];
  check("proxied traffic is accounted", !!proxied && proxied.outputBytes > 0 && proxied.commandCount === 1);

  c.send({ type: "bastion_start", port: 0 });
  const twice = await c.next((m) => m.type === "bastion_started");
  check("bastion refuses a second listener", twice.ok === false && twice.reason === "already_running");

  c.send({ type: "bastion_stop" });
  check("bastion stops", (await c.next((m) => m.type === "bastion_stopped")).ok === true);
  c.send({ type: "sshserver_stop" });
  await c.next((m) => m.type === "sshserver_stopped");

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });