import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";

// Minimal DER encoder: just the ASN.1 types a self-signed certificate needs.
function tlv(tag, body) {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const explicit = (n, body) => tlv(0xa0 + n, body);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
function oid(dotted) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** DER of an EC P-256 self-signed certificate, valid ten years, with the given SANs. */
export function selfSignedDer({ privateKey, publicKey }, { cn = "pocketdesk", dns = [], ips = [] } = {}) {
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), utf8(cn))));
  const now = new Date();
  const until = new Date(now.getTime() + 3650 * 86_400_000);
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive, no leading zero byte
  const san = Buffer.concat([
    ...dns.map((d) => tlv(0x82, Buffer.from(d, "ascii"))),
    ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  ]);
  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    seq(utcTime(now), utcTime(until)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(seq(oid("2.5.29.17"), tlv(0x04, seq(san))))),
  );
  const sig = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

// Self-signed cert generation shared by `npm run setup-tls` and the daemon's
// own first-run auto-generation. Pure node:crypto, so TLS never depends on openssl being installed.
export function generateSelfSignedCert(tls, configDir) {
  try {
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const der = selfSignedDer(pair, {
      dns: ["localhost", os.hostname()].filter((h) => /^[\w.-]+$/.test(h)),
      ips: ["127.0.0.1", ...lanAddresses()].filter((ip) => net.isIPv4(ip)),
    });
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
    fs.mkdirSync(path.dirname(tls.cert), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tls.key, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(tls.cert, pem);
    const fp = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
    fs.mkdirSync(path.join(configDir, "tls"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "tls", "fingerprint.txt"), fp + "\n");
    return true;
  } catch (e) {
    console.warn(`[pocketdesk] certificate generation failed: ${e?.message || e}`);
    return false;
  }
}
