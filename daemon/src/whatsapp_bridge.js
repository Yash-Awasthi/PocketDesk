/**
 * WhatsApp Bridge — Drive terminal sessions from WhatsApp.
 *
 * Inspired by whatsapp-claude-plugin.
 * Connects to WhatsApp as a linked device and exposes it
 * as a messaging channel for terminal interaction.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type WhatsAppStatus = 'disconnected' | 'qr_pending' | 'authenticated' | 'ready' | 'error';

export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  isGroup: boolean;
  groupId?: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface WhatsAppChannel {
  id: string;
  status: WhatsAppStatus;
  phoneNumber: string;
  connectedAt?: Date;
  lastMessageAt?: Date;
  sessionId: string;
  messageCount: number;
}

export interface ChannelConfig {
  sessionId: string;
  allowedNumbers: string[];
  commandPrefix: string;
  autoReply: boolean;
  maxMessageLength: number;
}

// ============================================================================
// WhatsApp Bridge Manager
// ============================================================================

export class WhatsAppBridgeManager extends EventEmitter {
  private channels: Map<string, WhatsAppChannel> = new Map();
  private messages: Map<string, WhatsAppMessage[]> = new Map();
  private configs: Map<string, ChannelConfig> = new Map();
  private qrCode: string | null = null;

  /**
   * Create a new WhatsApp channel.
   */
  createChannel(sessionId: string, config?: Partial<ChannelConfig>): WhatsAppChannel {
    const channel: WhatsAppChannel = {
      id: randomBytes(8).toString('hex'),
      status: 'disconnected',
      phoneNumber: '',
      sessionId,
      messageCount: 0,
    };

    this.channels.set(channel.id, channel);
    this.configs.set(channel.id, {
      sessionId,
      allowedNumbers: config?.allowedNumbers || [],
      commandPrefix: config?.commandPrefix || '!',
      autoReply: config?.autoReply ?? true,
      maxMessageLength: config?.maxMessageLength || 4096,
    });
    this.messages.set(channel.id, []);

    return channel;
  }

  /**
   * Start QR code authentication.
   */
  startAuthentication(channelId: string): string | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    channel.status = 'qr_pending';
    this.qrCode = randomBytes(32).toString('base64');
    this.emit('auth:qr', { channelId, qr: this.qrCode });
    return this.qrCode;
  }

  /**
   * Complete authentication (called after QR scan).
   */
  completeAuthentication(channelId: string, phoneNumber: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== 'qr_pending') return false;

    channel.status = 'authenticated';
    channel.phoneNumber = phoneNumber;
    channel.connectedAt = new Date();
    this.qrCode = null;

    this.emit('auth:completed', channel);
    return true;
  }

  /**
   * Handle incoming message.
   */
  handleMessage(channelId: string, message: WhatsAppMessage): void {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== 'ready') return;

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
      this.emit('command:received', {
        channelId,
        messageId: message.id,
        from: message.from,
        command,
      });
    } else {
      this.emit('message:received', {
        channelId,
        message,
      });
    }
  }

  /**
   * Send a reply message.
   */
  sendReply(channelId: string, to: string, body: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== 'ready') return false;

    const config = this.configs.get(channelId);
    if (!config) return false;

    // Truncate if too long
    const truncated = body.slice(0, config.maxMessageLength);

    const reply: WhatsAppMessage = {
      id: randomBytes(8).toString('hex'),
      from: channel.phoneNumber,
      to,
      body: truncated,
      timestamp: new Date(),
      isGroup: false,
    };

    const messages = this.messages.get(channelId) || [];
    messages.push(reply);
    this.messages.set(channelId, messages);

    this.emit('message:sent', { channelId, message: reply });
    return true;
  }

  /**
   * Send a command response.
   */
  sendCommandResponse(channelId: string, to: string, command: string, response: string): boolean {
    return this.sendReply(channelId, to, `*${command}*\n${response}`);
  }

  /**
   * Get message history for a channel.
   */
  getMessages(channelId: string, limit: number = 50): WhatsAppMessage[] {
    const messages = this.messages.get(channelId) || [];
    return messages.slice(-limit);
  }

  /**
   * Disconnect a channel.
   */
  disconnect(channelId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    channel.status = 'disconnected';
    this.emit('channel:disconnected', channel);
    return true;
  }

  /**
   * Get all channels.
   */
  getChannels(): WhatsAppChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalChannels: number;
    activeChannels: number;
    totalMessages: number;
  } {
    const channels = Array.from(this.channels.values());
    const totalMessages = channels.reduce((sum, c) => sum + c.messageCount, 0);

    return {
      totalChannels: channels.length,
      activeChannels: channels.filter((c) => c.status === 'ready').length,
      totalMessages,
    };
  }
}
