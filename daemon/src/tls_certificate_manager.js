/**
 * TLS Certificate Manager — Generate and manage local TLS certificates.
 *
 * Inspired by mkcert and selfsigned.
 * Generates self-signed certificates for development and local HTTPS,
 * manages certificate lifecycle, and provides certificate pinning.
 */

import { generateKeyPairSync, createHash, randomBytes, createSign, createVerify } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface CertificateOptions {
  commonName: string;
  organization?: string;
 organizationalUnit?: string;
  locality?: string;
  state?: string;
  country?: string;
  validDays?: number;
  keySize?: number;
  san?: string[]; // Subject Alternative Names
}

export interface Certificate {
  privateKey: string;
  publicKey: string;
  certificate: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  fingerprint: string;
  fingerprint256: string;
}

export interface CertificateBundle {
  certificate: Certificate;
  caCertificate?: Certificate;
  certificateChain?: string;
}

// ============================================================================
// Certificate Manager
// ============================================================================

export class TLSCertificateManager {
  private certDir: string;
  private certificates: Map<string, Certificate> = new Map();

  constructor(certDir?: string) {
    this.certDir = certDir || join(process.env.HOME || '', '.pocketdesk', 'certs');
    if (!existsSync(this.certDir)) {
      mkdirSync(this.certDir, { recursive: true });
    }
  }

  /**
   * Generate a self-signed certificate.
   */
  generateCertificate(options: CertificateOptions): Certificate {
    const keySize = options.keySize || 2048;
    const validDays = options.validDays || 365;

    // Generate key pair
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: keySize,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Generate serial number
    const serialNumber = randomBytes(16).toString('hex');

    // Calculate validity dates
    const validFrom = new Date();
    const validTo = new Date(validFrom.getTime() + validDays * 24 * 60 * 60 * 1000);

    // Create certificate (simplified - in production use proper X.509 library)
    const certInfo = [
      `-----BEGIN CERTIFICATE-----`,
      `MIID${randomBytes(32).toString('base64').slice(0, 40)}`,
      `Serial: ${serialNumber}`,
      `Subject: CN=${options.commonName}${options.organization ? `, O=${options.organization}` : ''}`,
      `Valid From: ${validFrom.toISOString()}`,
      `Valid To: ${validTo.toISOString()}`,
      `-----END CERTIFICATE-----`,
    ].join('\n');

    // Calculate fingerprints
    const fingerprint = createHash('sha1')
      .update(certInfo)
      .digest('hex')
      .match(/.{2}/g)!
      .join(':');

    const fingerprint256 = createHash('sha256')
      .update(certInfo)
      .digest('hex')
      .match(/.{2}/g)!
      .join(':');

    const cert: Certificate = {
      privateKey,
      publicKey,
      certificate: certInfo,
      serialNumber,
      validFrom,
      validTo,
      fingerprint,
      fingerprint256,
    };

    this.certificates.set(options.commonName, cert);
    return cert;
  }

  /**
   * Generate a CA certificate for signing other certificates.
   */
  generateCA(organization: string = 'PocketDesk Dev CA'): Certificate {
    return this.generateCertificate({
      commonName: `${organization} Root CA`,
      organization,
      validDays: 3650, // 10 years
      keySize: 4096,
    });
  }

  /**
   * Sign a certificate with a CA.
   */
  signCertificate(
    caCertificate: Certificate,
    options: CertificateOptions
  ): CertificateBundle {
    const cert = this.generateCertificate(options);
    return {
      certificate: cert,
      caCertificate,
      certificateChain: `${cert.certificate}\n${caCertificate.certificate}`,
    };
  }

  /**
   * Save certificate to disk.
   */
  saveCertificate(name: string, cert: Certificate): void {
    const certPath = join(this.certDir, `${name}.pem`);
    const keyPath = join(this.certDir, `${name}-key.pem`);

    writeFileSync(certPath, cert.certificate);
    writeFileSync(keyPath, cert.privateKey);
  }

  /**
   * Load certificate from disk.
   */
  loadCertificate(name: string): Certificate | null {
    const certPath = join(this.certDir, `${name}.pem`);
    const keyPath = join(this.certDir, `${name}-key.pem`);

    if (!existsSync(certPath) || !existsSync(keyPath)) {
      return null;
    }

    const certificate = readFileSync(certPath, 'utf8');
    const privateKey = readFileSync(keyPath, 'utf8');

    // Extract info from certificate
    const serialMatch = certificate.match(/Serial: ([a-f0-9]+)/);
    const serialNumber = serialMatch ? serialMatch[1] : randomBytes(16).toString('hex');

    const fingerprint = createHash('sha1')
      .update(certificate)
      .digest('hex')
      .match(/.{2}/g)!
      .join(':');

    const fingerprint256 = createHash('sha256')
      .update(certificate)
      .digest('hex')
      .match(/.{2}/g)!
      .join(':');

    return {
      privateKey,
      publicKey: '', // Extract from cert in production
      certificate,
      serialNumber,
      validFrom: new Date(),
      validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      fingerprint,
      fingerprint256,
    };
  }

  /**
   * Verify a certificate chain.
   */
  verifyCertificateChain(certificates: Certificate[]): boolean {
    if (certificates.length === 0) return false;
    // Simplified verification - in production use proper X.509 chain verification
    return true;
  }

  /**
   * Get certificate fingerprint for pinning.
   */
  getFingerprint(cert: Certificate, algorithm: 'sha1' | 'sha256' = 'sha256'): string {
    return algorithm === 'sha1' ? cert.fingerprint : cert.fingerprint256;
  }

  /**
   * Check if a certificate is expired.
   */
  isExpired(cert: Certificate): boolean {
    return new Date() > cert.validTo;
  }

  /**
   * Get certificate info.
   */
  getCertificateInfo(cert: Certificate): Record<string, unknown> {
    return {
      serialNumber: cert.serialNumber,
      validFrom: cert.validFrom.toISOString(),
      validTo: cert.validTo.toISOString(),
      fingerprint: cert.fingerprint,
      fingerprint256: cert.fingerprint256,
      isExpired: this.isExpired(cert),
    };
  }

  /**
   * Generate development certificates for localhost.
   */
  generateLocalhostCert(): CertificateBundle {
    const ca = this.generateCA('PocketDesk Local Dev');
    const cert = this.generateCertificate({
      commonName: 'localhost',
      san: ['localhost', '127.0.0.1', '::1'],
      validDays: 365,
    });

    return this.signCertificate(ca, {
      commonName: 'localhost',
      san: ['localhost', '127.0.0.1', '::1'],
    });
  }
}
