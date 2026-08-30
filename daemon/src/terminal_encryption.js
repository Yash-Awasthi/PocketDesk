/**
 * Terminal Encryption — End-to-end encryption for terminal sessions.
 *
 * Inspired by termpair's AES-GCM + RSA encryption.
 * Provides secure terminal data streaming with message counter-based IVs.
 */

import { createCipheriv, createDecipheriv, generateKeySync, randomBytes } from 'crypto';

// ============================================================================
// Constants
// ============================================================================

const IV_LENGTH = 12;
const KEY_LENGTH_BITS = 256;
const KEY_LENGTH_BYTES = KEY_LENGTH_BITS / 8;

// ============================================================================
// Types
// ============================================================================

export interface EncryptedPayload {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  messageCount: number;
}

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface SessionKey {
  key: Buffer;
  keyId: string;
  createdAt: Date;
}

// ============================================================================
// AES-GCM Encryption
// ============================================================================

/**
 * Generate a new AES-256-GCM secret key.
 */
export function generateSecretKey(): Buffer {
  return generateKeySync('aes', { length: KEY_LENGTH_BITS });
}

/**
 * Derive a key from a passphrase using PBKDF2.
 */
export function deriveKey(passphrase: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
  const actualSalt = salt || randomBytes(16);
  const { pbkdf2Sync } = require('crypto');
  const key = pbkdf2Sync(passphrase, actualSalt, 100000, KEY_LENGTH_BYTES, 'sha512');
  return { key, salt: actualSalt };
}

/**
 * Encrypt data using AES-256-GCM with a message counter-based IV.
 * The IV is deterministic based on message count, preventing reuse.
 */
export function aesEncrypt(key: Buffer, data: Buffer | string, messageCount: number): EncryptedPayload {
  const iv = Buffer.alloc(IV_LENGTH);
  // Write message count as little-endian 64-bit integer into IV
  iv.writeUInt32LE(messageCount & 0xffffffff, 0);
  iv.writeUInt32LE(Math.floor(messageCount / 0x100000000) & 0xffffffff, 4);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, typeof data === 'string' ? 'utf8' : undefined), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { iv, ciphertext: encrypted, tag, messageCount };
}

/**
 * Decrypt data using AES-256-GCM.
 */
export function aesDecrypt(key: Buffer, payload: EncryptedPayload): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

/**
 * Serialize an encrypted payload to a compact binary format.
 * Format: [messageCount:8][iv:12][tag:16][ciphertext:*]
 */
export function serializePayload(payload: EncryptedPayload): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(payload.messageCount & 0xffffffff, 0);
  header.writeUInt32LE(Math.floor(payload.messageCount / 0x100000000) & 0xffffffff, 4);
  return Buffer.concat([header, payload.iv, payload.tag, payload.ciphertext]);
}

/**
 * Deserialize a binary payload back to an EncryptedPayload.
 */
export function deserializePayload(data: Buffer): EncryptedPayload {
  const messageCount = data.readUInt32LE(0) + data.readUInt32LE(4) * 0x100000000;
  const iv = data.subarray(8, 8 + IV_LENGTH);
  const tag = data.subarray(8 + IV_LENGTH, 8 + IV_LENGTH + 16);
  const ciphertext = data.subarray(8 + IV_LENGTH + 16);
  return { iv, ciphertext, tag, messageCount };
}

// ============================================================================
// Session Manager
// ============================================================================

export class EncryptedTerminalSession {
  private key: Buffer;
  private messageCount = 0;
  private receivedCount = 0;

  constructor(key: Buffer) {
    this.key = key;
  }

  /**
   * Create a new session from a shared passphrase.
   */
  static fromPassphrase(passphrase: string, salt?: Buffer): { session: EncryptedTerminalSession; salt: Buffer } {
    const { key, salt: usedSalt } = deriveKey(passphrase, salt);
    return { session: new EncryptedTerminalSession(key), salt: usedSalt };
  }

  /**
   * Encrypt outgoing terminal data.
   */
  encrypt(data: string | Buffer): EncryptedPayload {
    return aesEncrypt(this.key, data, this.messageCount++);
  }

  /**
   * Decrypt incoming terminal data.
   */
  decrypt(payload: EncryptedPayload): string {
    return aesDecrypt(this.key, payload).toString('utf8');
  }

  /**
   * Get current message counter.
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Verify that a received payload has the expected message count.
   */
  verifySequence(payload: EncryptedPayload): boolean {
    return payload.messageCount === this.receivedCount++;
  }

  /**
   * Rotate the session key. Returns the new session with the same state.
   */
  rotate(): EncryptedTerminalSession {
    const newKey = generateSecretKey();
    const newSession = new EncryptedTerminalSession(newKey);
    newSession.messageCount = this.messageCount;
    newSession.receivedCount = this.receivedCount;
    return newSession;
  }
}
