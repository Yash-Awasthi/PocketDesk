/**
 * Mobile Auth — HMAC-based authentication for mobile device connections.
 *
 * Inspired by mobilecli's auth.rs.
 * Provides scoped, versioned authentication tokens for mobile clients
 * connecting to the PocketDesk daemon.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';

// ============================================================================
// Constants
// ============================================================================

export const AUTH_VERSION = 2;
const TOKEN_BYTES = 32;
const VERIFIER_DOMAIN = 'pocketdesk-auth-v2-verifier';
const TRANSCRIPT_DOMAIN = 'pocketdesk-auth-v2';

// ============================================================================
// Scopes
// ============================================================================

export const SCOPES = {
  SESSION_READ: 'session:read',
  SESSION_CONTROL: 'session:control',
  SESSION_SPAWN: 'session:spawn',
  FS_READ: 'fs:read',
  FS_WRITE: 'fs:write',
  FS_DELETE: 'fs:delete',
  FS_WATCH: 'fs:watch',
  FS_UPLOAD: 'fs:upload',
  PUSH_REGISTER: 'push:register',
  PROPOSAL_APPROVE: 'proposal:approve',
  PLUGIN_MANAGE: 'plugin:manage',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export function defaultScopes(): Scope[] {
  return [
    SCOPES.SESSION_READ,
    SCOPES.SESSION_CONTROL,
    SCOPES.FS_READ,
    SCOPES.FS_WRITE,
    SCOPES.PROPOSAL_APPROVE,
  ];
}

// ============================================================================
// Types
// ============================================================================

export interface AuthCredential {
  credentialId: string;
  verifier: string;
  name: string;
  scopes: Scope[];
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface AuthToken {
  credentialId: string;
  token: string;
  expiresAt?: Date;
}

export interface AuthChallenge {
  nonce: string;
  timestamp: number;
  version: number;
}

export interface AuthProof {
  credentialId: string;
  response: string;
  timestamp: number;
}

// ============================================================================
// Auth Manager
// ============================================================================

export class MobileAuthManager {
  private credentials: Map<string, AuthCredential> = new Map();
  private secretKey: Buffer;

  constructor(secretKey?: Buffer) {
    this.secretKey = secretKey || randomBytes(32);
  }

  /**
   * Register a new credential (device).
   */
  registerCredential(name: string, scopes?: Scope[]): AuthCredential {
    const token = randomBytes(TOKEN_BYTES);
    const verifier = this.deriveVerifier(token);

    const credential: AuthCredential = {
      credentialId: token.toString('hex').slice(0, 16),
      verifier,
      name,
      scopes: scopes || defaultScopes(),
      createdAt: new Date(),
    };

    this.credentials.set(credential.credentialId, credential);
    return credential;
  }

  /**
   * Generate an auth token for a registered credential.
   */
  generateToken(credentialId: string): AuthToken | null {
    const credential = this.credentials.get(credentialId);
    if (!credential || !this.isActive(credential)) return null;

    const payload = `${credentialId}:${Date.now()}:${AUTH_VERSION}`;
    const signature = createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');

    credential.lastUsedAt = new Date();

    return {
      credentialId,
      token: Buffer.from(`${payload}:${signature}`).toString('base64'),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };
  }

  /**
   * Verify an auth token.
   */
  verifyToken(tokenStr: string): { valid: boolean; credential?: AuthCredential; scopes?: Scope[] } {
    try {
      const decoded = Buffer.from(tokenStr, 'base64').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length !== 4) return { valid: false };

      const [credentialId, timestamp, version, signature] = parts;

      if (version !== String(AUTH_VERSION)) return { valid: false };

      const credential = this.credentials.get(credentialId);
      if (!credential || !this.isActive(credential)) return { valid: false };

      // Verify signature
      const payload = `${credentialId}:${timestamp}:${version}`;
      const expectedSignature = createHmac('sha256', this.secretKey)
        .update(payload)
        .digest('hex');

      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) return { valid: false };
      if (!timingSafeEqual(sigBuffer, expectedBuffer)) return { valid: false };

      // Check expiry (24 hours)
      const tokenTime = parseInt(timestamp, 10);
      if (Date.now() - tokenTime > 24 * 60 * 60 * 1000) return { valid: false };

      credential.lastUsedAt = new Date();

      return { valid: true, credential, scopes: credential.scopes };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Check if a credential has a specific scope.
   */
  hasScope(credential: AuthCredential, scope: Scope): boolean {
    return credential.scopes.includes(scope);
  }

  /**
   * Revoke a credential.
   */
  revoke(credentialId: string): boolean {
    const credential = this.credentials.get(credentialId);
    if (!credential) return false;
    credential.revokedAt = new Date();
    return true;
  }

  /**
   * Check if a credential is active.
   */
  isActive(credential: AuthCredential): boolean {
    return !credential.revokedAt;
  }

  /**
   * Generate a challenge for mutual authentication.
   */
  generateChallenge(): AuthChallenge {
    return {
      nonce: randomBytes(16).toString('hex'),
      timestamp: Date.now(),
      version: AUTH_VERSION,
    };
  }

  /**
   * Create a proof for a challenge.
   */
  createProof(credentialId: string, challenge: AuthChallenge, token: string): AuthProof {
    const response = createHmac('sha256', this.secretKey)
      .update(`${credentialId}:${challenge.nonce}:${challenge.timestamp}:${token}`)
      .digest('hex');

    return {
      credentialId,
      response,
      timestamp: Date.now(),
    };
  }

  /**
   * Verify a challenge proof.
   */
  verifyProof(proof: AuthProof, challenge: AuthChallenge, token: string): boolean {
    const credential = this.credentials.get(proof.credentialId);
    if (!credential || !this.isActive(credential)) return false;

    // Check challenge freshness (5 minutes)
    if (Date.now() - challenge.timestamp > 5 * 60 * 1000) return false;

    const expectedResponse = createHmac('sha256', this.secretKey)
      .update(`${proof.credentialId}:${challenge.nonce}:${challenge.timestamp}:${token}`)
      .digest('hex');

    const proofBuffer = Buffer.from(proof.response, 'hex');
    const expectedBuffer = Buffer.from(expectedResponse, 'hex');

    if (proofBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(proofBuffer, expectedBuffer);
  }

  /**
   * Derive a verifier from a token (stored on disk, not the token itself).
   */
  private deriveVerifier(token: Buffer): string {
    return createHash('sha256')
      .update(`${VERIFIER_DOMAIN}:${token.toString('hex')}`)
      .digest('hex');
  }

  /**
   * List all credentials.
   */
  listCredentials(): AuthCredential[] {
    return Array.from(this.credentials.values());
  }

  /**
   * Export credentials as JSON (for backup).
   */
  exportCredentials(): string {
    return JSON.stringify(
      Array.from(this.credentials.values()),
      null,
      2
    );
  }
}
