/**
 * WhatsApp Bridge — drive terminal sessions from WhatsApp.
 *
 * Inspired by whatsapp-claude-plugin. A channel links this daemon to WhatsApp
 * as a companion device over Baileys: `startAuthentication` boots the socket
 * and emits the real pairing QR, credentials live in the config directory so
 * a relink is not needed after a restart, and incoming messages flow through
 * the same allowlist and command-prefix routing as before.
 *
 * Baileys is an optional dependency, imported only when a channel actually
 * needs it. A channel created with `transport: "local"` skips it entirely and
 * is driven by `handleMessage`/`completeAuthentication` directly — that is
 * what the tests and other bridges use.
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * WhatsApp channel manager: QR auth lifecycle, allowlisted message intake,
 * command-prefix dispatch, replies, and history.
 */
export class WhatsAppBridgeManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.channels = new Map();
    /** @type {Map<string, object[]>} */
    this.messages = new Map();
    /** @type {Map<string, object>} */
    this.configs = new Map();
    /** @type {Map<string, object>} Live Baileys sockets, by channel id. */
    this.sockets = new Map();
    this.qrCode = null;
  }

  /**
   * Create a new WhatsApp channel bound to a session.
   */
  createChannel(sessionId, config = {}) {
    const channel = {
      id: randomBytes(8).toString("hex"),
      status: "disconnected",
      phoneNumber: "",
      sessionId,
      messageCount: 0,
    };

    channel.transport = config.transport === "local" ? "local" : "whatsapp";

    this.channels.set(channel.id, channel);
    this.configs.set(channel.id, {
      sessionId,
      allowedNumbers: config.allowedNumbers || [],
      commandPrefix: config.commandPrefix || "!",
      autoReply: config.autoReply ?? true,
      maxMessageLength: config.maxMessageLength || 4096,
    });
    this.messages.set(channel.id, []);

    return channel;
  }

  /**
   * Start authentication. A WhatsApp channel boots a Baileys socket and the
   * real pairing QR arrives on the `auth:qr` event (the return value is the
   * first QR only if one is already cached from a previous attempt). A local
   * channel gets a placeholder token to drive the same state machine.
   */
  async startAuthentication(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    channel.status = "qr_pending";
    if (channel.transport === "local") {
      this.qrCode = randomBytes(32).toString("base64");
      this.emit("auth:qr", { channelId, qr: this.qrCode });
      return this.qrCode;
    }
    await this._connectWhatsApp(channel);
    return this.qrCode;
  }

  /** Boot a Baileys companion-device socket for this channel. */
  async _connectWhatsApp(channel) {
    if (this.sockets.has(channel.id)) return;
    let baileys;
    try {
      baileys = await import("@whiskeysockets/baileys");
    } catch (err) {
      channel.status = "error";
      channel.error = "WhatsApp transport unavailable: install @whiskeysockets/baileys";
      this.emit("channel:error", { channelId: channel.id, error: channel.error });
      throw new Error(channel.error);
    }
    const makeWASocket = baileys.default?.makeWASocket ?? baileys.makeWASocket ?? baileys.default;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    const authDir = path.join(configDir, "whatsapp", channel.id);
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Baileys logs at info level to stdout by default, which would bury the
    // daemon's own output; QR and connection state reach us via events anyway.
    const silent = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => silent };
    const sock = makeWASocket({ auth: state, logger: silent, printQRInTerminal: false, syncFullHistory: false });
    this.sockets.set(channel.id, sock);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      if (update.qr) {
        this.qrCode = update.qr;
        this.emit("auth:qr", { channelId: channel.id, qr: update.qr });
      }
      if (update.connection === "open") {
        const jid = sock.user?.id || "";
        this.completeAuthentication(channel.id, jid.split(":")[0].split("@")[0]);
        this.markReady(channel.id);
      }
      if (update.connection === "close") {
        this.sockets.delete(channel.id);
        channel.status = "disconnected";
        const code = update.lastDisconnect?.error?.output?.statusCode;
        this.emit("channel:disconnected", channel);
        // Anything but an explicit logout is a transient drop worth redialling.
        if (code !== DisconnectReason?.loggedOut) this._connectWhatsApp(channel).catch(() => {});
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (m.key.fromMe) continue;
        const body = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? "";
        if (!body) continue;
        this.handleMessage(channel.id, {
          id: m.key.id,
          from: (m.key.remoteJid || "").split("@")[0],
          body,
          timestamp: new Date(Number(m.messageTimestamp) * 1000),
          isGroup: (m.key.remoteJid || "").endsWith("@g.us"),
          jid: m.key.remoteJid,
        });
      }
    });
  }

  /**
   * Complete authentication (called after QR scan).
   */
  completeAuthentication(channelId, phoneNumber) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== "qr_pending") return false;

    channel.status = "authenticated";
    channel.phoneNumber = phoneNumber;
    channel.connectedAt = new Date();
    this.qrCode = null;

    this.emit("auth:completed", channel);
    return true;
  }

  /**
   * Mark an authenticated channel ready (handshake complete).
   */
  markReady(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== "authenticated") return false;

    channel.status = "ready";
    this.emit("channel:ready", channel);
    return true;
  }

  /**
   * Handle incoming message.
   */
  handleMessage(channelId, message) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== "ready") return;

    const config = this.configs.get(channelId);
    if (!config) return;

    // Check if sender is allowed
    if (config.allowedNumbers.length > 0 && !config.allowedNumbers.includes(message.from)) {
      return;
    }

    channel.messageCount++;
    channel.lastMessageAt = new Date();

    const messages = this.messages.get(channelId) || [];
    messages.push(message);
    this.messages.set(channelId, messages);

    // Check if it's a command
    if (message.body.startsWith(config.commandPrefix)) {
      const command = message.body.slice(config.commandPrefix.length).trim();
      this.emit("command:received", {
        channelId,
        messageId: message.id,
        from: message.from,
        command,
      });
    } else {
      this.emit("message:received", {
        channelId,
        message,
      });
    }
  }

  /**
   * Send a reply message.
   */
  sendReply(channelId, to, body) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== "ready") return false;

    const config = this.configs.get(channelId);
    if (!config) return false;

    const truncated = body.slice(0, config.maxMessageLength);

    const reply = {
      id: randomBytes(8).toString("hex"),
      from: channel.phoneNumber,
      to,
      body: truncated,
      timestamp: new Date(),
      isGroup: false,
    };

    const messages = this.messages.get(channelId) || [];
    messages.push(reply);
    this.messages.set(channelId, messages);

    const sock = this.sockets.get(channelId);
    if (sock) {
      const jid = String(to).includes("@") ? to : `${to}@s.whatsapp.net`;
      sock.sendMessage(jid, { text: truncated }).catch((err) => this.emit("channel:error", { channelId, error: err.message }));
    }

    this.emit("message:sent", { channelId, message: reply });
    return true;
  }

  /**
   * Send a command response.
   */
  sendCommandResponse(channelId, to, command, response) {
    return this.sendReply(channelId, to, `*${command}*\n${response}`);
  }

  /**
   * Get message history for a channel.
   */
  getMessages(channelId, limit = 50) {
    const messages = this.messages.get(channelId) || [];
    return messages.slice(-limit);
  }

  /**
   * Disconnect a channel.
   */
  disconnect(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    const sock = this.sockets.get(channelId);
    this.sockets.delete(channelId);
    // end() before the status flip, so the close handler sees a dead channel
    // and does not redial it.
    channel.status = "disconnected";
    sock?.end?.(undefined);
    this.emit("channel:disconnected", channel);
    return true;
  }

  /**
   * Get all channels.
   */
  getChannels() {
    return Array.from(this.channels.values());
  }

  /**
   * Get statistics.
   */
  getStats() {
    const channels = Array.from(this.channels.values());
    const totalMessages = channels.reduce((sum, c) => sum + c.messageCount, 0);

    return {
      totalChannels: channels.length,
      activeChannels: channels.filter((c) => c.status === "ready").length,
      totalMessages,
    };
  }
}
