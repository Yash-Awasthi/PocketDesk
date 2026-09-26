/**
 * SSH Bastion — jump-host / transparent SSH bastion manager.
 *
 * Inspired by sshportal, ssh_bastion_cardea and skerryssh. Users, hosts,
 * access rules (with expiry), session accounting and invite tokens sit behind
 * a real SSH listener: a client authenticates with its registered public key
 * as `<user>@<host>` (the sshportal convention), the access rule is checked,
 * and the channel is proxied to the target host. Byte and command counts on a
 * session are measured from the proxied traffic.
 */
import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { configDir } from "./config.js";
import { verifySignature, hostKeyFile } from "./advanced_ssh_server.js";

const { Server, Client, utils } = ssh2;
const INVITE_TTL_MS = 7 * 24 * 3600_000;

/** Host key for the bastion listener, generated once and reused after. */
function hostKey() {
  return hostKeyFile(path.join(configDir, "bastion_host_ed25519"));
}

/** Wire blob of a public key in any accepted form, for comparison. */
function keyBlob(key) {
  const parsed = utils.parseKey(key);
  return parsed instanceof Error ? null : parsed.getPublicSSH().toString("base64");
}

export class SSHBastion extends EventEmitter {
  constructor() {
    super();
    this.users = new Map();
    this.hosts = new Map();
    this.sessions = new Map();
    this.accessRules = new Map();
    this.invites = new Map();
    this.server = null;
    this.port = null;
  }

  /**
   * Register a new user.
   */
  registerUser(username, publicKey, accessLevel = "limited", email) {
    const user = {
      id: randomBytes(8).toString("hex"),
      username,
      email,
      publicKey,
      accessLevel,
      createdAt: new Date(),
      isActive: true,
      allowedHosts: [],
      maxSessions: accessLevel === "admin" ? 10 : accessLevel === "superadmin" ? 50 : 3,
      tags: [],
    };
    this.users.set(user.id, user);
    this.emit("user:registered", user);
    return user;
  }

  /**
   * Register a new host.
   */
  registerHost(name, hostname, port, username, group = "default", credentials = {}) {
    const host = {
      id: randomBytes(8).toString("hex"),
      name,
      hostname,
      port,
      username,
      group,
      // Secrets for dialling the target; never returned by listHosts().
      credentials: { password: credentials.password, privateKeyPath: credentials.privateKeyPath },
      tags: [],
      createdAt: new Date(),
      isActive: true,
      environment: {},
    };
    this.hosts.set(host.id, host);
    this.emit("host:registered", host);
    return host;
  }

  /**
   * Create an access rule (explicit allow/deny for a user→host pair).
   */
  createAccessRule(userId, hostId, accessLevel, allowed = true, options = {}) {
    const rule = {
      id: randomBytes(8).toString("hex"),
      userId,
      hostId,
      accessLevel,
      allowed,
      createdAt: new Date(),
      expiresAt: options.expiresAt ? new Date(options.expiresAt) : undefined,
      conditions: options.conditions,
    };
    this.accessRules.set(rule.id, rule);
    this.emit("access:created", rule);
    return rule;
  }

  /**
   * Check if a user can access a host.
   */
  canAccess(userId, hostId) {
    const user = this.users.get(userId);
    const host = this.hosts.get(hostId);

    if (!user || !user.isActive) return { allowed: false, reason: "User not found or inactive" };
    if (!host || !host.isActive) return { allowed: false, reason: "Host not found or inactive" };

    // Explicit rules win (first match); expired rules deny.
    for (const rule of this.accessRules.values()) {
      if (rule.userId === userId && rule.hostId === hostId) {
        if (rule.expiresAt && rule.expiresAt < new Date()) {
          return { allowed: false, reason: "Access rule expired" };
        }
        return { allowed: rule.allowed, reason: rule.allowed ? "Access granted by rule" : "Access denied by rule" };
      }
    }

    // Host-group access falls back to the user's allowedHosts.
    if (user.allowedHosts.includes(host.group)) {
      return { allowed: true, reason: "Access granted by host group" };
    }

    return { allowed: false, reason: "No matching access rule" };
  }

  /**
   * Start a session (denied unless canAccess passes and the user is under
   * their session limit).
   */
  startSession(userId, hostId, clientIp) {
    const access = this.canAccess(userId, hostId);
    if (!access.allowed) return null;

    const user = this.users.get(userId);
    if (!user) return null;

    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
    if (activeSessions.length >= user.maxSessions) return null;

    const session = {
      id: randomBytes(8).toString("hex"),
      userId,
      hostId,
      startTime: new Date(),
      clientIp,
      inputBytes: 0,
      outputBytes: 0,
      commandCount: 0,
      isActive: true,
    };

    this.sessions.set(session.id, session);
    user.lastLogin = new Date();
    this.emit("session:started", session);
    return session;
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    session.endTime = new Date();
    session.isActive = false;
    this.emit("session:ended", session);
    return true;
  }

  getActiveSessions(userId) {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
  }

  getHostSessions(hostId, limit = 50) {
    return Array.from(this.sessions.values())
      .filter((s) => s.hostId === hostId)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  /**
   * Generate a user invite token (stored so acceptInvite can validate it).
   */
  generateInviteToken(email, accessLevel = "limited") {
    // Random, not a hash of email+timestamp: that was guessable by anyone who
    // knew the invitee's address and roughly when the invite was sent.
    const token = randomBytes(16).toString("hex");
    this.invites.set(token, { email, accessLevel, createdAt: new Date(), used: false });
    return token;
  }

  /**
   * Accept an invite token (validates against generated invites).
   */
  acceptInvite(token, username, publicKey) {
    const invite = this.invites.get(token);
    if (!invite || invite.used || Date.now() - invite.createdAt > INVITE_TTL_MS) return null;
    invite.used = true;
    return this.registerUser(username, publicKey, invite.accessLevel, invite.email);
  }

  listUsers() {
    return Array.from(this.users.values());
  }

  listHosts() {
    return Array.from(this.hosts.values()).map(({ credentials, ...h }) => h);
  }

  // ─── Real jump-host listener ───────────────────────────────────────

  /** Bind the bastion. Port 0 picks an ephemeral port, reported back. */
  async start({ port = 2223, host = "127.0.0.1" } = {}) {
    if (this.server) return { ok: false, reason: "already_running", port: this.port };
    this.server = new Server({ hostKeys: [hostKey()] }, (client, info) => this._onClient(client, info));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    }).catch((err) => { this.server = null; throw err; });
    this.port = this.server.address().port;
    this.emit("server:started", { port: this.port, host });
    return { ok: true, port: this.port, host };
  }

  async stop() {
    if (!this.server) return { ok: false, reason: "not_running" };
    for (const s of this.sessions.values()) s.client?.end();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.emit("server:stopped", { port: this.port });
    return { ok: true };
  }

  /** Split the sshportal-style login `user@host` (or `user:host`). */
  _route(login) {
    const [username, hostName] = String(login).split(/[@:]/);
    const user = Array.from(this.users.values()).find((u) => u.username === username);
    const host = Array.from(this.hosts.values()).find((h) => h.name === hostName);
    return { user, host };
  }

  _onClient(client, info) {
    let session = null;
    let route = null;

    client.on("authentication", (ctx) => {
      route = this._route(ctx.username);
      if (!route.user || !route.host) return ctx.reject();
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const expected = keyBlob(route.user.publicKey);
      if (!expected || expected !== ctx.key?.data?.toString("base64")) return ctx.reject();
      if (!this.canAccess(route.user.id, route.host.id).allowed) return ctx.reject();
      if (!ctx.signature) return ctx.accept(); // unsigned probe; the signed attempt follows
      // ssh2 leaves signature checks to the server; without one, knowing the public key is enough.
      if (!verifySignature(route.user.publicKey, ctx)) return ctx.reject();
      session = this.startSession(route.user.id, route.host.id, info?.ip || "unknown");
      if (!session) return ctx.reject();
      ctx.accept();
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const chan = accept();
        chan.once("exec", (acc, rej, execInfo) => {
          session.commandCount++;
          this._proxy(session, route.host, acc(), (target, done) => target.exec(execInfo.command, done));
        });
        chan.once("shell", (acc) => {
          this._proxy(session, route.host, acc(), (target, done) => target.shell(done));
        });
        chan.on("pty", (acc) => acc?.());
      });
    });

    client.on("close", () => { if (session) this.endSession(session.id); });
    client.on("error", () => { /* client vanished; close handles cleanup */ });
  }

  /** Dial the target and pipe one channel through it, counting bytes. */
  _proxy(session, host, stream, open) {
    const target = new Client();
    session.client = target;
    target.on("ready", () => {
      open(target, (err, remote) => {
        if (err) { stream.stderr.write(String(err.message)); stream.exit(255); return stream.end(); }
        remote.on("data", (d) => { session.outputBytes += d.length; stream.write(d); });
        remote.stderr?.on("data", (d) => stream.stderr.write(d));
        stream.on("data", (d) => { session.inputBytes += d.length; remote.write(d); });
        remote.on("close", (code) => { stream.exit(code ?? 0); stream.end(); target.end(); });
        stream.on("close", () => target.end());
      });
    });
    target.on("error", (err) => {
      try { stream.stderr.write(`bastion: ${err.message}`); stream.exit(255); stream.end(); } catch { /* client gone */ }
    });
    target.connect({
      host: host.hostname,
      port: host.port,
      username: host.username,
      password: host.credentials?.password,
      privateKey: host.credentials?.privateKeyPath ? fs.readFileSync(host.credentials.privateKeyPath) : undefined,
      // The bastion is the trust anchor for its own hosts: it records the key
      // it saw rather than refusing an unknown one on first contact.
      hostVerifier: (key) => {
        const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
        host.hostKeyFingerprint ??= fp;
        return host.hostKeyFingerprint === fp;
      },
    });
  }

  listAccessRules() {
    return Array.from(this.accessRules.values());
  }

  getStats() {
    const users = Array.from(this.users.values());
    const hosts = Array.from(this.hosts.values());
    const sessions = Array.from(this.sessions.values());
    return {
      running: !!this.server,
      port: this.port,
      totalUsers: users.length,
      activeUsers: users.filter((u) => u.isActive).length,
      totalHosts: hosts.length,
      activeHosts: hosts.filter((h) => h.isActive).length,
      activeSessions: sessions.filter((s) => s.isActive).length,
      totalSessions: sessions.length,
    };
  }
}