/**
 * SSH + VNC + SFTP client profiles for PocketDesk.
 * Extracted from: haven-ssh-client (Free SSH, VNC & SFTP client for Android).
 * Patterns: multi-protocol connection profiles, host-key TOFU verification,
 *           SSH key management, session bookkeeping.
 *
 * Connections are simulated (profiles + session lifecycle + events), like the
 * rd_* remote-desktop bridge: the surface is wired and protocol-tested, and a
 * real SSH/SFTP transport can be layered on later.
 */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

export class MultiProtocolClient extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.hostKeys = new Map();
    this.sshKeys = new Map();
    this.vncSessions = new Map();
    this.sftpSessions = new Map();
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
    if (filter.tag) {
      profiles = profiles.filter((p) => p.tags.includes(filter.tag));
    }
    if (filter.protocol) {
      profiles = profiles.filter((p) => p.protocols.includes(filter.protocol));
    }
    return profiles;
  }

  // ─── SSH Operations ────────────────────────────────────────────────

  async connectSSH(profileId) {
    const profile = this.connections.get(profileId);
    if (!profile) throw new Error("Profile not found");

    profile.lastConnected = Date.now();
    profile.connectCount++;

    const session = {
      id: crypto.randomUUID(),
      profileId,
      protocol: "ssh",
      status: "connected",
      connectedAt: Date.now(),
      channels: new Map(),
    };

    this.emit("ssh:connected", { profileId, sessionId: session.id });
    return session;
  }

  async disconnectSSH(sessionId) {
    this.emit("ssh:disconnected", { sessionId });
    return { ok: true };
  }

  async openTerminal(sessionId, options = {}) {
    const terminal = {
      id: crypto.randomUUID(),
      sessionId,
      type: "terminal",
      pty: options.pty || "xterm-256color",
      width: options.width || 120,
      height: options.height || 40,
      status: "open",
    };
    this.emit("terminal:opened", terminal);
    return terminal;
  }

  // ─── VNC Operations ────────────────────────────────────────────────

  async connectVNC(profileId, options = {}) {
    const profile = this.connections.get(profileId);
    if (!profile) throw new Error("Profile not found");

    const session = {
      id: crypto.randomUUID(),
      profileId,
      protocol: "vnc",
      status: "connected",
      connectedAt: Date.now(),
      width: options.width || 1920,
      height: options.height || 1080,
      encoding: options.encoding || "tight",
      quality: options.quality || 6,
    };

    this.vncSessions.set(session.id, session);
    this.emit("vnc:connected", session);
    return session;
  }

  async disconnectVNC(sessionId) {
    const session = this.vncSessions.get(sessionId);
    if (session) {
      session.status = "disconnected";
      this.vncSessions.delete(sessionId);
      this.emit("vnc:disconnected", session);
      return { ok: true };
    }
    return { ok: false };
  }

  // ─── SFTP Operations ───────────────────────────────────────────────

  async connectSFTP(profileId) {
    const profile = this.connections.get(profileId);
    if (!profile) throw new Error("Profile not found");

    const session = {
      id: crypto.randomUUID(),
      profileId,
      protocol: "sftp",
      status: "connected",
      connectedAt: Date.now(),
      currentDir: "/home/" + profile.username,
    };

    this.sftpSessions.set(session.id, session);
    this.emit("sftp:connected", session);
    return session;
  }

  async listRemoteDir(sessionId, path) {
    this.emit("sftp:readdir", { sessionId, path });
    return { path, files: [] };
  }

  async uploadFile(sessionId, localPath, remotePath) {
    this.emit("sftp:upload", { sessionId, localPath, remotePath });
    return { localPath, remotePath, status: "uploaded" };
  }

  async downloadFile(sessionId, remotePath, localPath) {
    this.emit("sftp:download", { sessionId, remotePath, localPath });
    return { remotePath, localPath, status: "downloaded" };
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

  generateKey(type = "ed25519", name = "") {
    const keyPair = crypto.generateKeyPairSync(type);
    const id = crypto.randomUUID();
    const key = {
      id,
      name: name || `Key ${id.slice(0, 8)}`,
      type,
      publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" }),
      createdAt: Date.now(),
    };
    this.sshKeys.set(id, key);
    return key;
  }

  importKey(publicKeyPEM, name = "") {
    const id = crypto.randomUUID();
    const key = { id, name, publicKey: publicKeyPEM, createdAt: Date.now(), imported: true };
    this.sshKeys.set(id, key);
    return key;
  }

  deleteKey(id) {
    return this.sshKeys.delete(id);
  }

  listKeys() {
    return Array.from(this.sshKeys.values());
  }

  // ─── Status ────────────────────────────────────────────────────────

  getStatus() {
    return {
      profiles: this.connections.size,
      hostKeys: this.hostKeys.size,
      sshKeys: this.sshKeys.size,
      vncSessions: this.vncSessions.size,
      sftpSessions: this.sftpSessions.size,
    };
  }
}