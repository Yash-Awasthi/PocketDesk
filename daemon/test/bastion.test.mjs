// VNC bridge + SSH bastion + advanced SSH server + multi-protocol client
// absorption test — exercises the newly wired protocol surfaces from the
// noVNC/guacamole (vnc_bridge), sshportal/bifroest/cardea (ssh_bastion,
// advanced_ssh_server) and haven-ssh-client (ssh_vnc_client) inspirations.
// Fully in-memory — deterministic, no external processes, no real listeners
// beyond the ephemeral VNC TCP port (port 0) started and stopped in-test.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8826;
const CLI_PORT = 46826;
const TOKEN = "bastiontoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // ── VNC bridge (noVNC/guacamole: TCP frame server + frame feed) ─────────
  c.send({ type: "vnc_start", port: 0 });
  const started = await c.next((m) => m.type === "vnc_started");
  check("vnc_start binds ephemeral port", started.ok === true && started.port > 0);

  c.send({ type: "vnc_status" });
  const st = await c.next((m) => m.type === "vnc_status");
  check("vnc_status reports running", st.running === true && st.port === started.port);

  c.send({ type: "vnc_frame", data: Buffer.from("fakeframe").toString("base64"), width: 1280, height: 720 });
  await c.next((m) => m.type === "vnc_frame_ok");
  const frameEvt = await c.next((m) => m.type === "vnc_event" && m.vncEvent === "received");
  check("vnc_frame processed + broadcast", frameEvt.width === 1280 && frameEvt.height === 720);

  c.send({ type: "vnc_stop" });
  const stopped = await c.next((m) => m.type === "vnc_stopped");
  check("vnc_stop acks", stopped.ok === true);
  c.send({ type: "vnc_status" });
  const st2 = await c.next((m) => m.type === "vnc_status");
  check("vnc_status reports stopped", st2.running === false);

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

  // ── Multi-protocol client (haven-ssh-client: profiles + host-key TOFU) ───
  c.send({ type: "profile_create", name: "home", host: "192.168.1.10", port: 22, username: "yasha", protocols: ["ssh", "sftp"] });
  const pc = await c.next((m) => m.type === "profile_created");
  check("profile created", pc.ok === true && pc.profile.host === "192.168.1.10");
  const profileId = pc.profile.id;

  c.send({ type: "profile_connect", id: profileId, protocol: "ssh" });
  const conn = await c.next((m) => m.type === "profile_connected");
  check("profile connects (ssh)", conn.ok === true && conn.session.protocol === "ssh");
  const connEvt = await c.next((m) => m.type === "mproto_event" && m.mprotoEvent === "connected");
  check("connect event broadcast", connEvt.profileId === profileId);

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
  check("mproto_status counts", ms.profiles === 1 && ms.hostKeys === 1 && ms.sshKeys === 1);

  c.send({ type: "profile_list" });
  const pl = await c.next((m) => m.type === "profile_list");
  check("profile_list round-trips", pl.items.length === 1 && pl.items[0].id === profileId);

  c.send({ type: "sshkey_delete", id: kg.key.id });
  const kd = await c.next((m) => m.type === "sshkey_deleted");
  check("sshkey_delete acks", kd.ok === true);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });