/**
 * Terminal Chat — Real-time messaging over WebSockets for terminal users.
 *
 * Inspired by marchat.
 * Provides lightweight terminal-based chat with optional E2E encryption,
 * plugin system, and multi-user support.
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type UserRole = 'admin' | 'moderator' | 'user';

export interface ChatUser {
  id: string;
  username: string;
  role: UserRole;
  isOnline: boolean;
  joinedAt: Date;
  lastSeen: Date;
  color: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  content: string;
  timestamp: Date;
  isEncrypted: boolean;
  channel: string;
  replyTo?: string;
  reactions: Map<string, string[]>;
}

export interface ChatChannel {
  name: string;
  description: string;
  isPrivate: boolean;
  createdAt: Date;
  messageCount: number;
  memberIds: Set<string>;
}

export interface ChatPlugin {
  name: string;
  version: string;
  description: string;
  isEnabled: boolean;
  hooks: string[];
}

// ============================================================================
// Terminal Chat Manager
// ============================================================================

export class TerminalChatManager extends EventEmitter {
  private users: Map<string, ChatUser> = new Map();
  private messages: Map<string, ChatMessage[]> = new Map();
  private channels: Map<string, ChatChannel> = new Map();
  private plugins: Map<string, ChatPlugin> = new Map();
  private e2eKey: Buffer | null = null;

  private readonly USER_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  ];

  private colorIndex = 0;

  constructor() {
    super();
    // Create default channel
    this.createChannel('general', 'General discussion');
    this.createChannel('dev', 'Development talk');
    this.createChannel('random', 'Off-topic chat');
  }

  /**
   * Set E2E encryption key.
   */
  setE2EKey(key: string): void {
    this.e2eKey = createHash('sha256').update(key).digest();
  }

  /**
   * Join the chat.
   */
  join(username: string, role: UserRole = 'user'): ChatUser {
    const user: ChatUser = {
      id: randomBytes(8).toString('hex'),
      username,
      role,
      isOnline: true,
      joinedAt: new Date(),
      lastSeen: new Date(),
      color: this.nextColor(),
    };

    this.users.set(user.id, user);

    // Auto-join general channel
    const general = this.channels.get('general');
    if (general) {
      general.memberIds.add(user.id);
    }

    this.emit('user:joined', user);
    return user;
  }

  /**
   * Leave the chat.
   */
  leave(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    user.isOnline = false;

    // Remove from all channels
    for (const channel of this.channels.values()) {
      channel.memberIds.delete(userId);
    }

    this.emit('user:left', user);
    return true;
  }

  /**
   * Send a message.
   */
  sendMessage(
    userId: string,
    content: string,
    channel: string = 'general',
    replyTo?: string
  ): ChatMessage | null {
    const user = this.users.get(userId);
    if (!user || !user.isOnline) return null;

    const chatChannel = this.channels.get(channel);
    if (!chatChannel) return null;

    const message: ChatMessage = {
      id: randomBytes(8).toString('hex'),
      userId,
      username: user.username,
      content: this.e2eKey ? this.encrypt(content) : content,
      timestamp: new Date(),
      isEncrypted: !!this.e2eKey,
      channel,
      replyTo,
      reactions: new Map(),
    };

    const channelMessages = this.messages.get(channel) || [];
    channelMessages.push(message);
    this.messages.set(channel, channelMessages);

    chatChannel.messageCount++;
    user.lastSeen = new Date();

    this.emit('message:sent', message);
    return message;
  }

  /**
   * Get messages from a channel.
   */
  getMessages(channel: string, limit: number = 50): ChatMessage[] {
    const messages = this.messages.get(channel) || [];
    return messages.slice(-limit);
  }

  /**
   * Create a new channel.
   */
  createChannel(name: string, description: string = '', isPrivate: boolean = false): ChatChannel {
    const channel: ChatChannel = {
      name,
      description,
      isPrivate,
      createdAt: new Date(),
      messageCount: 0,
      memberIds: new Set(),
    };

    this.channels.set(name, channel);
    this.messages.set(name, []);
    this.emit('channel:created', channel);
    return channel;
  }

  /**
   * Join a channel.
   */
  joinChannel(userId: string, channelName: string): boolean {
    const user = this.users.get(userId);
    const channel = this.channels.get(channelName);
    if (!user || !channel) return false;

    channel.memberIds.add(userId);
    this.emit('channel:user-joined', { userId, channel: channelName });
    return true;
  }

  /**
   * Add a reaction to a message.
   */
  addReaction(userId: string, messageId: string, channel: string, emoji: string): boolean {
    const messages = this.messages.get(channel) || [];
    const message = messages.find((m) => m.id === messageId);
    if (!message) return false;

    const reactions = message.reactions.get(emoji) || [];
    if (!reactions.includes(userId)) {
      reactions.push(userId);
      message.reactions.set(emoji, reactions);
      this.emit('message:reaction', { messageId, emoji, userId });
    }
    return true;
  }

  /**
   * Register a plugin.
   */
  registerPlugin(plugin: Omit<ChatPlugin, 'isEnabled'>): void {
    this.plugins.set(plugin.name, { ...plugin, isEnabled: true });
    this.emit('plugin:registered', plugin);
  }

  /**
   * Get online users.
   */
  getOnlineUsers(): ChatUser[] {
    return Array.from(this.users.values()).filter((u) => u.isOnline);
  }

  /**
   * Get channels.
   */
  getChannels(): ChatChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Encrypt a message.
   */
  private encrypt(text: string): string {
    if (!this.e2eKey) return text;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.e2eKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  /**
   * Decrypt a message.
   */
  private decrypt(data: string): string {
    if (!this.e2eKey) return data;
    const buf = Buffer.from(data, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.e2eKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  }

  /**
   * Get next user color.
   */
  private nextColor(): string {
    const color = this.USER_COLORS[this.colorIndex % this.USER_COLORS.length];
    this.colorIndex++;
    return color;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalUsers: number;
    onlineUsers: number;
    totalChannels: number;
    totalMessages: number;
    plugins: number;
  } {
    const users = Array.from(this.users.values());
    const totalMessages = Array.from(this.messages.values()).reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    return {
      totalUsers: users.length,
      onlineUsers: users.filter((u) => u.isOnline).length,
      totalChannels: this.channels.size,
      totalMessages,
      plugins: this.plugins.size,
    };
  }
}
