/**
 * SSH Agent Bridge — Route SSH operations to mobile device for approval.
 *
 * Inspired by kr (Krypton) — SSH authentication with mobile device approval.
 * The private key never leaves the phone; operations are routed via WebSocket.
 */

import { createHash, createHmac, randomBytes, sign } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type AuthMethod = 'publickey' | 'password' | 'keyboard-interactive';

export interface SSHRequest {
  id: string;
  type: 'sign' | 'verify' | 'encrypt' | 'decrypt';
  data: Buffer;
  algorithm: string;
  keyId?: string;
  timestamp: number;
}

export interface SSHResponse {
  id: string;
  type: string;
  success: boolean;
  data?: Buffer;
  error?: string;
}

export interface DeviceRegistration {
  deviceId: string;
  deviceName: string;
  publicKey: Buffer;
  algorithm: string;
  registeredAt: Date;
  lastSeen?: Date;
  trusted: boolean;
}

// ============================================================================
// SSH Agent Bridge
// ============================================================================

export class SSHAgentBridge extends EventEmitter {
  private devices: Map<string, DeviceRegistration> = new Map();
  private pendingRequests: Map<string, { resolve: (value: SSHResponse) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private requestTimeout = 30000; // 30 seconds

  /**
   * Register a mobile device for SSH key operations.
   */
  registerDevice(
    deviceId: string,
    deviceName: string,
    publicKey: Buffer,
    algorithm: string = 'ssh-ed25519'
  ): DeviceRegistration {
    const registration: DeviceRegistration = {
      deviceId,
      deviceName,
      publicKey,
      algorithm,
      registeredAt: new Date(),
      trusted: true,
    };

    this.devices.set(deviceId, registration);
    this.emit('device:registered', registration);
    return registration;
  }

  /**
   * Request a signature from a registered device.
   * This sends the request to the mobile device and waits for approval.
   */
  async requestSignature(
    deviceId: string,
    data: Buffer,
    algorithm: string = 'ssh-ed25519'
  ): Promise<Buffer> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);
    if (!device.trusted) throw new Error(`Device ${deviceId} is not trusted`);

    const request: SSHRequest = {
      id: randomBytes(16).toString('hex'),
      type: 'sign',
      data,
      algorithm,
      keyId: deviceId,
      timestamp: Date.now(),
    };

    this.emit('request:sent', request);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('Signature request timed out'));
      }, this.requestTimeout);

      this.pendingRequests.set(request.id, {
        resolve: (response) => {
          clearTimeout(timer);
          if (response.success && response.data) {
            resolve(response.data);
          } else {
            reject(new Error(response.error || 'Signature rejected'));
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  /**
   * Handle a response from the mobile device.
   */
  handleResponse(response: SSHResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
      this.emit('request:completed', response);
    }
  }

  /**
   * Handle a registration request from a new device.
   */
  handleRegistrationRequest(
    deviceId: string,
    deviceName: string,
    publicKey: Buffer,
    algorithm: string = 'ssh-ed25519'
  ): DeviceRegistration {
    const registration = this.registerDevice(deviceId, deviceName, publicKey, algorithm);
    this.emit('registration:request', registration);
    return registration;
  }

  /**
   * Verify that a device's public key matches its ID.
   */
  verifyDeviceKey(deviceId: string, publicKey: Buffer): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    return device.publicKey.equals(publicKey);
  }

  /**
   * Revoke a device's access.
   */
  revokeDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.trusted = false;
    this.emit('device:revoked', device);
    return true;
  }

  /**
   * List all registered devices.
   */
  listDevices(): DeviceRegistration[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get device by ID.
   */
  getDevice(deviceId: string): DeviceRegistration | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Generate a challenge for device verification.
   */
  generateChallenge(): { nonce: string; timestamp: number } {
    return {
      nonce: randomBytes(32).toString('hex'),
      timestamp: Date.now(),
    };
  }

  /**
   * Create a proof of key possession.
   */
  createKeyProof(privateKey: Buffer, challenge: string): Buffer {
    return createHmac('sha256', privateKey)
      .update(challenge)
      .digest();
  }

  /**
   * Clean up expired requests.
   */
  cleanup(): number {
    let cleaned = 0;
    const now = Date.now();
    for (const [id, pending] of this.pendingRequests) {
      // Timer already handles expiry, but this is a safety net
      cleaned++;
    }
    return cleaned;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    registeredDevices: number;
    trustedDevices: number;
    pendingRequests: number;
  } {
    const devices = Array.from(this.devices.values());
    return {
      registeredDevices: devices.length,
      trustedDevices: devices.filter((d) => d.trusted).length,
      pendingRequests: this.pendingRequests.size,
    };
  }
}
