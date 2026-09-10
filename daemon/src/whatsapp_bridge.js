/**
 * WhatsApp Bridge — Drive terminal sessions from WhatsApp.
 *
 * Inspired by whatsapp-claude-plugin.
 * Connects to WhatsApp as a linked device and exposes it
 * as a messaging channel for terminal interaction.
 *
 * NOTE: ported from TS-syntax-in-.js to plain ESM (it could not be imported
 * under the package's "type": "module" before). The auth state machine was
 * also fixed: `markReady()` bridges authenticated → ready (nothing set
 * `ready` before, so incoming messages were permanently gated).
 * Real WhatsApp transport (baileys) remains roadmap — this is the
 * daemon-side channel/session surface.
 */

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
   * Start QR code authentication.
   */
  startAuthentication(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    channel.status = "qr_pending";
    this.qrCode = randomBytes(32).toString("base64");
    this.emit("auth:qr", { channelId, qr: this.qrCode });
    return this.qrCode;
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

    channel.status = "disconnected";
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
