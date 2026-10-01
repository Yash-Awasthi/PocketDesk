
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// A ws client can ask the SSH listeners to bind elsewhere; only loopback is honored; anything
// else (0.0.0.0, a LAN IP) would turn an already-authed phone session into a standing backdoor
// reachable from off the PC, so it is silently dropped back to the server's own default.
function safeHost(h) {
  return typeof h === "string" && LOOPBACK_HOSTS.has(h) ? h : undefined;
}

export default function sshHandlers(ctx) {
  const { send, bastion, sshSrv, mpc, access } = ctx;
  // These create standing backdoor capability (a listener, or a login credential) on the PC, so
  // they respect the same "pause control" switch the desktop/remote surface already honors.
  function controlOk(ws, type) {
    if (access.controlAllowed) return true;
    send(ws, { type, ok: false, error: "control paused" });
    return false;
  }
  return {
    // ── SSH bastion (sshportal/bifroest: users, hosts, access rules) ─────
    async bastion_user_add(ws, msg) {
      if (!controlOk(ws, "bastion_user_added")) return;
      const user = bastion.registerUser(String(msg.username ?? ""), String(msg.publicKey ?? ""), String(msg.accessLevel ?? "limited"), msg.email ? String(msg.email) : undefined);
      send(ws, { type: "bastion_user_added", ok: true, user });
    },
    async bastion_user_list(ws, msg) {
      send(ws, { type: "bastion_user_list", items: bastion.listUsers() });
    },
    async bastion_host_add(ws, msg) {
      const host = bastion.registerHost(String(msg.name ?? ""), String(msg.hostname ?? ""), Number(msg.port) || 22, String(msg.username ?? ""), msg.group ? String(msg.group) : undefined, { password: msg.password, privateKeyPath: msg.privateKeyPath });
      const { credentials, ...safe } = host;
      send(ws, { type: "bastion_host_added", ok: true, host: safe });
    },
    async bastion_start(ws, msg) {
      if (!controlOk(ws, "bastion_started")) return;
      try {
        const r = await bastion.start({ port: msg.port, host: safeHost(msg.host) });
        send(ws, { type: "bastion_started", ...r });
      } catch (e) {
        send(ws, { type: "bastion_started", ok: false, error: e.message });
      }
    },
    async bastion_stop(ws, msg) {
      send(ws, { type: "bastion_stopped", ...(await bastion.stop()) });
    },
    async bastion_host_list(ws, msg) {
      send(ws, { type: "bastion_host_list", items: bastion.listHosts() });
    },
    async bastion_rule_add(ws, msg) {
      const rule = bastion.createAccessRule(String(msg.userId ?? ""), String(msg.hostId ?? ""), String(msg.accessLevel ?? "limited"), msg.allowed !== false, { expiresAt: msg.expiresAt, conditions: msg.conditions });
      send(ws, { type: "bastion_rule_added", ok: true, rule });
    },
    async bastion_access(ws, msg) {
      send(ws, { type: "bastion_access", ...bastion.canAccess(String(msg.userId ?? ""), String(msg.hostId ?? "")) });
    },
    async bastion_session_start(ws, msg) {
      const session = bastion.startSession(String(msg.userId ?? ""), String(msg.hostId ?? ""), String(msg.clientIp ?? "phone"));
      send(ws, { type: "bastion_session_started", ok: !!session, session: session ? (({ client, ...x }) => x)(session) : null });
    },
    async bastion_session_end(ws, msg) {
      const ok = bastion.endSession(String(msg.sessionId ?? ""));
      send(ws, { type: "bastion_session_ended", ok });
    },
    async bastion_sessions(ws, msg) {
      const items = msg.userId ? bastion.getActiveSessions(String(msg.userId)) : Array.from(bastion.sessions.values()).filter((s) => s.isActive);
      // The live ssh2 client on a proxied session stays off the wire.
      send(ws, { type: "bastion_sessions", items: items.map(({ client, ...x }) => x) });
    },
    async bastion_stats(ws, msg) {
      send(ws, { type: "bastion_stats", ...bastion.getStats() });
    },
    async bastion_invite(ws, msg) {
      const token = bastion.generateInviteToken(String(msg.email ?? ""), String(msg.accessLevel ?? "limited"));
      send(ws, { type: "bastion_invite", token });
    },
    async bastion_invite_accept(ws, msg) {
      const user = bastion.acceptInvite(String(msg.token ?? ""), String(msg.username ?? ""), String(msg.publicKey ?? ""));
      send(ws, { type: "bastion_invite_accepted", ok: !!user, user: user ?? null });
    },
    // ── Advanced SSH server (bifroest/sshwifty: auth + command control) ──
    async sshserver_user_add(ws, msg) {
      if (!controlOk(ws, "sshserver_user_added")) return;
      const user = sshSrv.registerUser(String(msg.username ?? ""), { password: msg.password ? String(msg.password) : undefined, publicKey: msg.publicKey ? String(msg.publicKey) : undefined, allowedCommands: Array.isArray(msg.allowedCommands) ? msg.allowedCommands.map(String) : [], maxSessions: Number(msg.maxSessions) || 3, isAdmin: !!msg.isAdmin });
      send(ws, { type: "sshserver_user_added", ok: true, user });
    },
    async sshserver_user_list(ws, msg) {
      // passwordHash never leaves the daemon: it is a scrypt hash, but
      // still no reason to expose it.
      send(ws, { type: "sshserver_user_list", items: Array.from(sshSrv.users.values()).map(({ passwordHash, ...u }) => u) });
    },
    async sshserver_session_create(ws, msg) {
      // The auth surface existed but nothing called it — a registered
      // username alone opened a session.
      const username = String(msg.username ?? "");
      const method = String(msg.method ?? "token");
      if (!sshSrv.authenticate(username, method, msg.credential)) {
        send(ws, { type: "sshserver_session_created", ok: false, session: null, error: "authentication failed" });
        return;
      }
      const session = sshSrv.createSession(username, String(msg.clientIp ?? "phone"), method);
      send(ws, { type: "sshserver_session_created", ok: !!session, session: session ? (({ client, pty, ...x }) => x)(session) : null });
    },
    async sshserver_exec(ws, msg) {
      const ok = sshSrv.executeCommand(String(msg.sessionId ?? ""), String(msg.command ?? ""));
      send(ws, { type: "sshserver_exec_ok", ok });
    },
    async sshserver_session_end(ws, msg) {
      const ok = sshSrv.endSession(String(msg.sessionId ?? ""));
      send(ws, { type: "sshserver_session_ended", ok });
    },
    async sshserver_start(ws, msg) {
      if (!controlOk(ws, "sshserver_started")) return;
      try {
        const r = await sshSrv.start({ port: msg.port, host: safeHost(msg.host) });
        send(ws, { type: "sshserver_started", ...r });
      } catch (e) {
        send(ws, { type: "sshserver_started", ok: false, error: e.message });
      }
    },
    async sshserver_stop(ws, msg) {
      send(ws, { type: "sshserver_stopped", ...(await sshSrv.stop()) });
    },
    async sshserver_sessions(ws, msg) {
      // Live handles (ssh2 client, PTY) stay off the wire.
      send(ws, { type: "sshserver_sessions", items: sshSrv.getActiveSessions().map(({ client, pty, ...s }) => s) });
    },
    async sshserver_stats(ws, msg) {
      send(ws, { type: "sshserver_stats", ...sshSrv.getStats() });
    },
    // ── Multi-protocol client (haven-ssh-client: profiles + host-key TOFU) ──
    async profile_create(ws, msg) {
      const profile = mpc.createProfile({ name: msg.name, host: String(msg.host ?? ""), port: Number(msg.port) || 22, username: String(msg.username ?? ""), protocols: Array.isArray(msg.protocols) ? msg.protocols.map(String) : ["ssh"], authMethod: String(msg.authMethod ?? "password"), keyId: msg.keyId ? String(msg.keyId) : undefined, tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [] });
      send(ws, { type: "profile_created", ok: true, profile });
    },
    async profile_list(ws, msg) {
      send(ws, { type: "profile_list", items: mpc.listProfiles({ tag: msg.tag, protocol: msg.protocol }) });
    },
    async profile_update(ws, msg) {
      try {
        const profile = mpc.updateProfile(String(msg.id ?? ""), msg.updates ?? {});
        send(ws, { type: "profile_updated", ok: true, profile });
      } catch (e) {
        send(ws, { type: "profile_updated", ok: false, error: e.message });
      }
    },
    async profile_delete(ws, msg) {
      const ok = mpc.deleteProfile(String(msg.id ?? ""));
      send(ws, { type: "profile_deleted", ok });
    },
    async profile_connect(ws, msg) {
      const proto = String(msg.protocol ?? "ssh");
      const id = String(msg.id ?? "");
      // Credentials are used for this connect only — never stored on the profile.
      const opts = { password: msg.password, passphrase: msg.passphrase, port: msg.port, timeoutMs: msg.timeoutMs };
      try {
        const session = proto === "vnc" ? await mpc.connectVNC(id, opts) : proto === "sftp" ? await mpc.connectSFTP(id, opts) : await mpc.connectSSH(id, opts);
        // The live handles (ssh2 client, TCP socket, sftp channel) never go on the wire.
        const { client, socket, sftp, channels, ...safe } = session;
        send(ws, { type: "profile_connected", ok: true, session: safe });
      } catch (e) {
        send(ws, { type: "profile_connected", ok: false, error: e.message });
      }
    },
    async profile_disconnect(ws, msg) {
      const proto = String(msg.protocol ?? "ssh");
      const sid = String(msg.sessionId ?? "");
      const r = proto === "vnc" ? await mpc.disconnectVNC(sid) : proto === "sftp" ? await mpc.disconnectSFTP(sid) : await mpc.disconnectSSH(sid);
      send(ws, { type: "profile_disconnected", ok: r.ok === true });
    },
    async hostkey_verify(ws, msg) {
      send(ws, { type: "hostkey_verify", ...mpc.verifyHostKey(String(msg.host ?? ""), Number(msg.port) || 22, String(msg.fingerprint ?? ""), String(msg.keyType ?? "ssh-ed25519")) });
    },
    async hostkey_list(ws, msg) {
      send(ws, { type: "hostkey_list", items: mpc.listHostKeys() });
    },
    async sshkey_generate(ws, msg) {
      try {
        const key = mpc.generateKey(String(msg.algo ?? "ed25519"), msg.name ? String(msg.name) : "", { bits: msg.bits, passphrase: msg.passphrase });
        send(ws, { type: "sshkey_generated", ok: true, key: { id: key.id, name: key.name, type: key.type, publicKey: key.publicKey, fingerprint: key.fingerprint } });
      } catch (e) {
        send(ws, { type: "sshkey_generated", ok: false, error: e.message });
      }
    },
    async sshkey_list(ws, msg) {
      send(ws, { type: "sshkey_list", items: mpc.listKeys() });
    },
    async sshkey_delete(ws, msg) {
      const ok = mpc.deleteKey(String(msg.id ?? ""));
      send(ws, { type: "sshkey_deleted", ok });
    },
    async mproto_status(ws, msg) {
      send(ws, { type: "mproto_status", ...mpc.getStatus() });
    },
  };
}
