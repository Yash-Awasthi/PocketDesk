/**
 * SSH + VNC + SFTP client profiles for PocketDesk.
 * Extracted from: haven-ssh-client (Free SSH, VNC & SFTP client for Android).
 *
 * Connections are real: SSH and SFTP run over ssh2, VNC performs the RFB
 * handshake and reads the server's framebuffer geometry. Host keys are
 * trust-on-first-use — a changed key aborts the connection rather than
 * prompting, since there is nobody at the daemon to answer the prompt.
 * Generated keys are written to `~/.pocketdesk/sshkeys` with owner-only
 * permissions; the private half never crosses the protocol.
 */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import ssh2 from "ssh2";
import { configDir } from "./config.js";
import { generateKeyPair } from "./advanced_ssh_server.js";

const { Client, utils } = ssh2;

const KEY_DIR = path.join(configDir, "sshkeys");

/** RFB: read exactly `n` bytes from a socket, or reject on close/timeout. */
function readBytes(socket, n, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (buf) => {
      chunks.push(buf);
      got += buf.length;
      if (got < n) return;
      cleanup();
      const all = Buffer.concat(chunks);
      // Anything past `n` belongs to the next read: hand it back to the stream.
      if (all.length > n) socket.unshift(all.subarray(n));
      resolve(all.subarray(0, n));
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error("connection closed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

/** VNC authentication: DES with each key byte's bits reversed (RFB quirk). */
function vncDesResponse(password, challenge) {
  const key = Buffer.alloc(8);
  const pw = Buffer.from(String(password), "latin1");
  for (let i = 0; i < 8; i++) {
    let b = pw[i] ?? 0, r = 0;
    for (let bit = 0; bit < 8; bit++) r |= ((b >> bit) & 1) << (7 - bit);
    key[i] = r;
  }
  const out = Buffer.alloc(16);
  for (let off = 0; off < 16; off += 8) {
    const c = crypto.createCipheriv("des-ecb", key, null);
    c.setAutoPadding(false);
    Buffer.concat([c.update(challenge.subarray(off, off + 8)), c.final()]).copy(out, off);
  }
  return out;
}

export class MultiProtocolClient extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.hostKeys = new Map();
    this.sshKeys = new Map();
    this.sshSessions = new Map();
    this.vncSessions = new Map();
    this.sftpSessions = new Map();
    this._loadKeys();
  }

  _loadKeys() {
    try {
      for (const name of fs.readdirSync(KEY_DIR)) {
        if (!name.endsWith(".pub")) continue;
        const id = name.slice(0, -4);
        const meta = path.join(KEY_DIR, `${id}.json`);
        if (!fs.existsSync(meta)) continue;
        this.sshKeys.set(id, { ...JSON.parse(fs.readFileSync(meta, "utf8")), publicKey: fs.readFileSync(path.join(KEY_DIR, name), "utf8").trim() });
      }
    } catch { /* no key directory yet */ }
  }

  // ─── Connection Profile Management ─────────────────────────────────

  createProfile(config) {
    const id = crypto.randomUUID();
    const profile = {
      id,
      name: config.name || `Profile ${id.slice(0, 8)}`,
      host: config.host,
      port: config.port || 22,
      username: config.username,
      protocols: config.protocols || ["ssh"],
      authMethod: config.authMethod || "password",
      keyId: config.keyId,
      color: config.color || "#4CAF50",
      tags: config.tags || [],
      lastConnected: null,
      connectCount: 0,
      notes: config.notes || "",
    };
    this.connections.set(id, profile);
    return profile;
  }

  updateProfile(id, updates) {
    const profile = this.connections.get(id);
    if (!profile) throw new Error(`Profile ${id} not found`);
    Object.assign(profile, updates);
    return profile;
  }

  deleteProfile(id) {
    return this.connections.delete(id);
  }

  listProfiles(filter = {}) {
    let profiles = Array.from(this.connections.values());
    if (filter.tag) profiles = profiles.filter((p) => p.tags.includes(filter.tag));
    if (filter.protocol) profiles = profiles.filter((p) => p.protocols.includes(filter.protocol));
    return profiles;
  }

  // ─── SSH Operations ────────────────────────────────────────────────

  /** Credentials for a profile: private key when one is selected, else password. */
  _auth(profile, options) {
    const auth = { username: profile.username };
    if (profile.keyId) {
      const key = this.sshKeys.get(profile.keyId);
      if (!key?.privatePath) throw new Error("selected key has no private half on this machine");
      auth.privateKey = fs.readFileSync(key.privatePath);
      if (options.passphrase) auth.passphrase = options.passphrase;
    } else {
      if (!options.password) throw new Error("password required");
      auth.password = options.password;
    }
    return auth;
  }

  /** Open a real SSH connection, verifying the host key trust-on-first-use. */
  async connectSSH(profileId, options = {}) {
    const profile = this.connections.get(profileId);
    if (!profile) throw new Error("Profile not found");

    const client = new Client();
    let verdict = { status: "accepted", isNew: false };

    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      client.connect({
        host: profile.host,
        port: profile.port,
        readyTimeout: Number(options.timeoutMs) || 15000,
        ...this._auth(profile, options),
        hostVerifier: (key) => {
          const fp = crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
          verdict = this.verifyHostKey(profile.host, profile.port, `SHA256:${fp}`, utils.parseKey(key)?.type || "unknown");
          return verdict.status === "accepted";
        },
      });
    }).catch((err) => {
      client.end();
      throw new Error(verdict.status === "changed" ? "host key changed — connection refused" : err.message);
    });

    profile.lastConnected = Date.now();
    profile.connectCount++;

    const session = { id: crypto.randomUUID(), profileId, protocol: "ssh", status: "connected", connectedAt: Date.now(), hostKey: verdict, client, channels: new Map() };
    this.sshSessions.set(session.id, session);
    client.on("close", () => {
      session.status = "disconnected";
      this.sshSessions.delete(session.id);
      this.emit("ssh:disconnected", { sessionId: session.id });
    });
    this.emit("ssh:connected", { profileId, sessionId: session.id, hostKey: verdict });
    return session;
  }

  async disconnectSSH(sessionId) {
    const session = this.sshSessions.get(sessionId);
    if (!session) return { ok: false };
    session.client.end();
    this.sshSessions.delete(sessionId);
    this.emit("ssh:disconnected", { sessionId });
    return { ok: true };
  }

  /** Interactive shell channel; output is emitted as `terminal:data`. */
  async openTerminal(sessionId, options = {}) {
    const session = this.sshSessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const stream = await new Promise((resolve, reject) => {
      session.client.shell(
        { term: options.pty || "xterm-256color", cols: options.width || 120, rows: options.height || 40 },
        (err, s) => (err ? reject(err) : resolve(s)),
      );
    });
    const terminal = { id: crypto.randomUUID(), sessionId, type: "terminal", pty: options.pty || "xterm-256color", width: options.width || 120, height: options.height || 40, status: "open" };
    session.channels.set(terminal.id, stream);
    stream.on("data", (chunk) => this.emit("terminal:data", { terminalId: terminal.id, sessionId, data: chunk.toString("base64") }));
    stream.on("close", () => {
      terminal.status = "closed";
      session.channels.delete(terminal.id);
      this.emit("terminal:closed", { terminalId: terminal.id, sessionId });
    });
    this.emit("terminal:opened", terminal);
    return terminal;
  }

  writeTerminal(sessionId, terminalId, data) {
    const stream = this.sshSessions.get(sessionId)?.channels.get(terminalId);
    if (!stream) return { ok: false };
    stream.write(data);
    return { ok: true };
  }

  /** Run one command and collect its output. */
  async exec(sessionId, command) {
    const session = this.sshSessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    return new Promise((resolve, reject) => {
      session.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = "", stderr = "";
        stream.on("data", (c) => { stdout += c; });
        stream.stderr.on("data", (c) => { stderr += c; });
        stream.on("close", (code) => resolve({ stdout, stderr, code }));
      });
    });
  }

  // ─── VNC Operations ────────────────────────────────────────────────

  /**
   * Real RFB connection: version handshake, optional VNC authentication,
   * then ServerInit, which carries the framebuffer geometry and desktop name.
   */
  async connectVNC(profileId, options = {}) {
    const profile = this.connections.get(profileId);
    if (!profile) throw new Error("Profile not found");
    const port = Number(options.port) || (profile.vncPort ?? 5900);

    const socket = net.createConnection({ host: profile.host, port });
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.setTimeout(Number(options.timeoutMs) || 15000, () => reject(new Error("timeout")));
      });
      socket.setTimeout(0);

      const version = (await readBytes(socket, 12)).toString("ascii");
      if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) throw new Error("not an RFB server");
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));

      const count = (await readBytes(socket, 1))[0];
      if (count === 0) {
        const len = (await readBytes(socket, 4)).readUInt32BE(0);
        throw new Error((await readBytes(socket, len)).toString("utf8"));
      }
      const types = await readBytes(socket, count);
      const scheme = types.includes(1) ? 1 : types.includes(2) ? 2 : types[0];
      socket.write(Buffer.from([scheme]));

      if (scheme === 2) {
        if (!options.password) throw new Error("password required");
        socket.write(vncDesResponse(options.password, await readBytes(socket, 16)));
      } else if (scheme !== 1) {
        throw new Error(`unsupported VNC security type ${scheme}`);
      }
      if ((await readBytes(socket, 4)).readUInt32BE(0) !== 0) throw new Error("VNC authentication failed");

      socket.write(Buffer.from([options.shared === false ? 0 : 1]));
      const init = await readBytes(socket, 24);
      const nameLen = init.readUInt32BE(20);
      const name = nameLen ? (await readBytes(socket, nameLen)).toString("utf8") : "";

      const session = {
        id: crypto.randomUUID(),
        profileId,
        protocol: "vnc",
        status: "connected",
        connectedAt: Date.now(),
        width: init.readUInt16BE(0),
        height: init.readUInt16BE(2),
        bitsPerPixel: init[4],
        desktopName: name,
        socket,
      };
      this.vncSessions.set(session.id, session);
      socket.on("close", () => {
        this.vncSessions.delete(session.id);
        this.emit("vnc:disconnected", { id: session.id });
      });
      this.emit("vnc:connected", { ...session, socket: undefined });
      return session;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  async disconnectVNC(sessionId) {
    const session = this.vncSessions.get(sessionId);
    if (!session) return { ok: false };
    session.socket.destroy();
    this.vncSessions.delete(sessionId);
    this.emit("vnc:disconnected", { id: sessionId });
    return { ok: true };
  }

  // ─── SFTP Operations ───────────────────────────────────────────────

  async connectSFTP(profileId, options = {}) {
    const ssh = await this.connectSSH(profileId, options);
    const sftp = await new Promise((resolve, reject) => ssh.client.sftp((err, s) => (err ? reject(err) : resolve(s))));
    const cwd = await new Promise((resolve) => sftp.realpath(".", (err, p) => resolve(err ? "/" : p)));
    const session = { id: crypto.randomUUID(), profileId, sshSessionId: ssh.id, protocol: "sftp", status: "connected", connectedAt: Date.now(), currentDir: cwd, sftp };
    this.sftpSessions.set(session.id, session);
    this.emit("sftp:connected", { ...session, sftp: undefined });
    return session;
  }

  async disconnectSFTP(sessionId) {
    const session = this.sftpSessions.get(sessionId);
    if (!session) return { ok: false };
    session.sftp.end();
    this.sftpSessions.delete(sessionId);
    await this.disconnectSSH(session.sshSessionId);
    this.emit("sftp:disconnected", { id: sessionId });
    return { ok: true };
  }

  async listRemoteDir(sessionId, dir) {
    const session = this.sftpSessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const target = dir || session.currentDir;
    const list = await new Promise((resolve, reject) => session.sftp.readdir(target, (err, l) => (err ? reject(err) : resolve(l))));
    session.currentDir = target;
    this.emit("sftp:readdir", { sessionId, path: target, count: list.length });
    return {
      path: target,
      files: list.map((e) => ({ name: e.filename, dir: (e.attrs.mode & 0o170000) === 0o040000, size: e.attrs.size, mtime: e.attrs.mtime })),
    };
  }

  async uploadFile(sessionId, localPath, remotePath) {
    const session = this.sftpSessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    await new Promise((resolve, reject) => session.sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve())));
    this.emit("sftp:upload", { sessionId, localPath, remotePath });
    return { localPath, remotePath, status: "uploaded", size: fs.statSync(localPath).size };
  }

  async downloadFile(sessionId, remotePath, localPath) {
    const session = this.sftpSessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    await new Promise((resolve, reject) => session.sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve())));
    this.emit("sftp:download", { sessionId, remotePath, localPath });
    return { remotePath, localPath, status: "downloaded", size: fs.statSync(localPath).size };
  }

  // ─── Host Key Verification (TOFU) ──────────────────────────────────

  verifyHostKey(host, port, keyFingerprint, keyType) {
    const keyId = `${host}:${port}`;
    const existing = this.hostKeys.get(keyId);

    if (!existing) {
      this.hostKeys.set(keyId, { fingerprint: keyFingerprint, type: keyType, firstSeen: Date.now(), verified: true });
      this.emit("hostkey:new", { host, port, fingerprint: keyFingerprint });
      return { status: "accepted", isNew: true };
    }

    if (existing.fingerprint === keyFingerprint) {
      return { status: "accepted", isNew: false };
    }

    this.emit("hostkey:changed", { host, port, oldFingerprint: existing.fingerprint, newFingerprint: keyFingerprint });
    return { status: "changed", oldFingerprint: existing.fingerprint, newFingerprint: keyFingerprint };
  }

  listHostKeys() {
    return Array.from(this.hostKeys.entries()).map(([keyId, v]) => ({ keyId, ...v }));
  }

  // ─── SSH Key Management ────────────────────────────────────────────

  /** Generate an OpenSSH keypair; the private half stays on disk, mode 0600. */
  generateKey(type = "ed25519", name = "", { bits, passphrase } = {}) {
    const opts = type === "rsa" ? { bits: Number(bits) || 3072 } : {};
    if (passphrase) Object.assign(opts, { passphrase, cipher: "aes256-cbc" });
    const pair = generateKeyPair(type === "rsa" ? "rsa" : type === "ecdsa" ? "ecdsa" : "ed25519", opts);

    const id = crypto.randomUUID();
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    const privatePath = path.join(KEY_DIR, id);
    fs.writeFileSync(privatePath, pair.private, { mode: 0o600 });
    fs.writeFileSync(`${privatePath}.pub`, `${pair.public}\n`, { mode: 0o644 });

    const parsed = utils.parseKey(pair.public);
    const key = {
      id,
      name: name || `Key ${id.slice(0, 8)}`,
      type,
      publicKey: pair.public,
      fingerprint: `SHA256:${crypto.createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
      privatePath,
      createdAt: Date.now(),
    };
    fs.writeFileSync(`${privatePath}.json`, JSON.stringify({ ...key, publicKey: undefined }), { mode: 0o600 });
    this.sshKeys.set(id, key);
    return key;
  }

  /** Import an OpenSSH public key (authorized_keys line); rejects junk. */
  importKey(publicKey, name = "") {
    const parsed = utils.parseKey(publicKey);
    if (parsed instanceof Error) throw new Error(`not a valid public key: ${parsed.message}`);
    const id = crypto.randomUUID();
    const key = {
      id,
      name: name || `Key ${id.slice(0, 8)}`,
      type: parsed.type,
      publicKey: String(publicKey).trim(),
      fingerprint: `SHA256:${crypto.createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
      createdAt: Date.now(),
      imported: true,
    };
    this.sshKeys.set(id, key);
    return key;
  }

  deleteKey(id) {
    const key = this.sshKeys.get(id);
    if (key?.privatePath) {
      for (const f of [key.privatePath, `${key.privatePath}.pub`, `${key.privatePath}.json`]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
    return this.sshKeys.delete(id);
  }

  /** Never exposes the private half — only where it lives. */
  listKeys() {
    return Array.from(this.sshKeys.values()).map(({ privatePath, ...k }) => ({ ...k, hasPrivate: !!privatePath }));
  }

  // ─── Status ────────────────────────────────────────────────────────

  getStatus() {
    return {
      profiles: this.connections.size,
      hostKeys: this.hostKeys.size,
      sshKeys: this.sshKeys.size,
      sshSessions: this.sshSessions.size,
      vncSessions: this.vncSessions.size,
      sftpSessions: this.sftpSessions.size,
    };
  }

  dispose() {
    for (const s of this.sshSessions.values()) s.client.end();
    for (const s of this.vncSessions.values()) s.socket.destroy();
    this.sshSessions.clear();
    this.vncSessions.clear();
    this.sftpSessions.clear();
  }
}
