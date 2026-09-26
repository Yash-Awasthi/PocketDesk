/**
 * Advanced SSH Server — drop-in SSH server with pluggable auth, per-user
 * command allowlists, session recording and idle reaping.
 *
 * Inspired by bifroest and sshwifty (and sshportal). `start()` puts a real
 * ssh2 listener in front of the user/session bookkeeping: clients connect
 * with a password or public key, exec requests are gated by the per-user
 * allowlist before they run, and shell requests get a PTY. The host key is
 * generated once and kept in the config directory, so a client's
 * trust-on-first-use record survives daemon restarts.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import pty from "node-pty";
import { configDir } from "./config.js";

const { Server, utils } = ssh2;
const IS_WIN = process.platform === "win32";
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 10 * 60_000;

/** ssh2 now and then emits an ed25519 private key its own parser rejects; draw again until one parses. */
export function generateKeyPair(type = "ed25519", opts) {
  for (;;) {
    const pair = utils.generateKeyPairSync(type, opts);
    if (!(utils.parseKey(pair.private, opts?.passphrase) instanceof Error)) return pair;
  }
}

/** A persisted host key, replaced when missing or unreadable (an earlier bad draw). */
export function hostKeyFile(file) {
  if (!fs.existsSync(file) || utils.parseKey(fs.readFileSync(file)) instanceof Error) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generateKeyPair().private, { mode: 0o600 });
  }
  return fs.readFileSync(file);
}

/** Host key for the listener, generated on first use and reused after. */
function hostKey() {
  return hostKeyFile(path.join(configDir, "ssh_host_ed25519"));
}

function constantTimeEquals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when a signed publickey attempt was signed by the registered key. */
export function verifySignature(publicKey, ctx) {
  const key = utils.parseKey(publicKey);
  return !(key instanceof Error) && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored ?? "").split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(password ?? ""), salt, 64).toString("hex");
  return constantTimeEquals(candidate, hash);
}

export class AdvancedSSHServerManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      port: config.port || 2222,
      host: config.host || "127.0.0.1",
      maxSessions: config.maxSessions || 10,
      idleTimeout: config.idleTimeout || 300000,
      allowTcpForwarding: config.allowTcpForwarding ?? true,
      allowAgentForwarding: config.allowAgentForwarding ?? false,
      forceCommand: config.forceCommand,
    };
    this.sessions = new Map();
    this.users = new Map();
    this.recordings = new Map();
    this.authFailures = new Map();
    this.server = null;
  }

  /**
   * Register a user.
   */
  registerUser(username, options = {}) {
    const user = {
      username,
      passwordHash: options.password ? hashPassword(options.password) : undefined,
      publicKey: options.publicKey,
      allowedCommands: options.allowedCommands || [],
      maxSessions: options.maxSessions || 3,
      isAdmin: options.isAdmin ?? false,
    };
    this.users.set(username, user);
    this.emit("user:registered", user);
    return user;
  }

  /**
   * Authenticate a user. A user registered with no credential at all is open
   * by construction; one with a credential must present THAT credential. The
   * old trailing `return true` let `method: "publickey"` walk straight past a
   * configured password hash.
   */
  authenticate(username, method, credential) {
    const user = this.users.get(username);
    if (!user) return false;
    if (!user.passwordHash && !user.publicKey) return true;

    if (method === "password" && user.passwordHash) {
      return verifyPassword(credential, user.passwordHash);
    }

    if (method === "publickey" && user.publicKey) {
      // Compare the wire blob, not the text: the stored key may be an
      // authorized_keys line while the client offers the raw key data.
      const stored = utils.parseKey(user.publicKey);
      const offered = stored instanceof Error ? null : stored.getPublicSSH();
      if (offered) return constantTimeEquals(offered.toString("base64"), String(credential ?? ""));
      return constantTimeEquals(String(credential ?? ""), user.publicKey);
    }

    return false;
  }

  /**
   * Create a new session.
   */
  createSession(username, clientIp, method) {
    const user = this.users.get(username);
    if (!user) return null;

    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.username === username && s.isActive
    );
    if (activeSessions.length >= user.maxSessions) return null;

    const session = {
      id: randomBytes(8).toString("hex"),
      username,
      clientIp,
      authMethod: method,
      connectedAt: new Date(),
      lastActivity: new Date(),
      commands: [],
      isActive: true,
    };

    this.sessions.set(session.id, session);
    this.recordings.set(session.id, []);
    this.emit("session:created", session);
    return session;
  }

  /**
   * Execute a command in a session (respects the per-user allowlist and the
   * server-level forceCommand; recorded with a timestamp).
   */
  executeCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    const user = this.users.get(session.username);
    if (!user) return false;

    if (user.allowedCommands.length > 0) {
      // The command runs through a shell, so chaining or substitution would smuggle in an unlisted one.
      if ((IS_WIN ? /[&|<>^%\r\n]/ : /[;&|<>`$()\r\n]/).test(command)) return false;
      // A rule's words must lead the command: "git" allows any git, "git status" only that subcommand.
      const argv = command.trim().split(/\s+/);
      if (!user.allowedCommands.some((rule) => String(rule).trim().split(/\s+/).every((w, i) => argv[i] === w))) return false;
    }

    const actualCommand = this.config.forceCommand || command;

    session.commands.push(actualCommand);
    session.lastActivity = new Date();

    const recording = this.recordings.get(sessionId) || [];
    recording.push(`[${new Date().toISOString()}] ${actualCommand}`);
    this.recordings.set(sessionId, recording);

    this.emit("command:executed", { sessionId, command: actualCommand });
    return true;
  }

  /**
   * End a session.
   */
  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    this.emit("session:ended", session);
    return true;
  }

  getRecording(sessionId) {
    return this.recordings.get(sessionId) || [];
  }

  /**
   * End sessions idle past the configured timeout; returns count ended.
   */
  checkIdleSessions() {
    let ended = 0;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.isActive) {
        const idleTime = now - session.lastActivity.getTime();
        if (idleTime > this.config.idleTimeout) {
          this.endSession(id);
          ended++;
        }
      }
    }
    return ended;
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter((s) => s.isActive);
  }

  // ─── Real SSH listener ─────────────────────────────────────────────

  /** Bind the SSH listener. Port 0 picks an ephemeral port, reported back. */
  async start({ port, host } = {}) {
    if (this.server) return { ok: false, reason: "already_running", port: this.config.port };
    const listenPort = port ?? this.config.port;
    const listenHost = host ?? this.config.host;

    this.server = new Server({ hostKeys: [hostKey()] }, (client, info) => this._onClient(client, info));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(listenPort, listenHost, () => resolve());
    }).catch((err) => { this.server = null; throw err; });

    this.config.port = this.server.address().port;
    this.config.host = listenHost;
    this.emit("server:started", { port: this.config.port, host: listenHost });
    return { ok: true, port: this.config.port, host: listenHost };
  }

  async stop() {
    if (!this.server) return { ok: false, reason: "not_running" };
    for (const s of this.sessions.values()) if (s.client) s.client.end();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.emit("server:stopped", { port: this.config.port });
    return { ok: true };
  }

  _onClient(client, info) {
    let session = null;
    const clientIp = info?.ip || "unknown";

    client.on("authentication", (ctx) => {
      const now = Date.now();
      const rec = this.authFailures.get(clientIp);
      const failures = rec && now - rec.at < AUTH_WINDOW_MS ? rec.n : 0;
      if (failures >= MAX_AUTH_FAILURES) return ctx.reject();
      // Unsigned publickey probes are how clients pick among their keys, so only real attempts count.
      const fail = () => {
        if (ctx.method === "password" || ctx.signature) {
          for (const [ip, r] of this.authFailures) if (now - r.at > AUTH_WINDOW_MS) this.authFailures.delete(ip);
          this.authFailures.set(clientIp, { n: failures + 1, at: now });
        }
        return ctx.reject(["password", "publickey"]);
      };
      const credential = ctx.method === "password" ? ctx.password
        : ctx.method === "publickey" ? ctx.key?.data?.toString("base64")
        : undefined;
      const user = this.users.get(ctx.username);
      // Credential-less users exist for phone-side bookkeeping only, never for network logins.
      if (!user || (!user.passwordHash && !user.publicKey)) return fail();
      if (!this.authenticate(ctx.username, ctx.method, credential)) return fail();
      // A publickey probe carries no signature yet: accept it so the client
      // proceeds to the signed attempt, but do not open a session for it.
      if (ctx.method === "publickey" && !ctx.signature) return ctx.accept();
      // ssh2 leaves signature checks to the server; without one, knowing the public key is enough.
      if (ctx.method === "publickey" && !verifySignature(user.publicKey, ctx)) return fail();
      this.authFailures.delete(clientIp);
      session = this.createSession(ctx.username, clientIp, ctx.method);
      if (!session) return ctx.reject();
      session.client = client;
      ctx.accept();
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const chan = accept();
        chan.on("exec", (acc, rej, execInfo) => {
          if (!this.executeCommand(session.id, execInfo.command)) return rej();
          const stream = acc();
          const command = this.config.forceCommand || execInfo.command;
          const proc = spawn(command, { shell: true, cwd: process.env.HOME || process.cwd() });
          proc.stdout.on("data", (d) => stream.write(d));
          proc.stderr.on("data", (d) => stream.stderr.write(d));
          proc.on("close", (code) => { stream.exit(code ?? 0); stream.end(); });
          proc.on("error", (err) => { stream.stderr.write(String(err.message)); stream.exit(127); stream.end(); });
        });
        chan.on("shell", (acc, rej) => {
          // An interactive shell would bypass the per-user command allowlist.
          if (this.users.get(session.username)?.allowedCommands.length) return rej();
          const stream = acc();
          const shell = IS_WIN ? "powershell.exe" : process.env.SHELL || "bash";
          const term = pty.spawn(shell, [], { name: "xterm-256color", cols: 100, rows: 30, cwd: process.env.HOME || process.cwd(), env: process.env });
          session.pty = term;
          term.onData((d) => { try { stream.write(d); } catch { /* channel closed */ } });
          term.onExit(({ exitCode }) => { try { stream.exit(exitCode); stream.end(); } catch { /* already closed */ } });
          stream.on("data", (d) => term.write(d.toString()));
          stream.on("close", () => term.kill());
        });
        chan.on("pty", (acc) => acc?.());
        chan.on("window-change", (acc, rej, dims) => {
          session?.pty?.resize(dims.cols, dims.rows);
          acc?.();
        });
      });
    });

    client.on("close", () => { if (session) this.endSession(session.id); });
    client.on("error", () => { /* client vanished; close handles cleanup */ });
  }

  getStats() {
    const sessions = Array.from(this.sessions.values());
    const totalCommands = sessions.reduce((sum, s) => sum + s.commands.length, 0);
    return {
      running: !!this.server,
      port: this.server ? this.config.port : null,
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.isActive).length,
      totalUsers: this.users.size,
      totalCommands,
    };
  }
}