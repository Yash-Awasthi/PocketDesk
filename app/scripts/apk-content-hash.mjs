#!/usr/bin/env node
// A fingerprint that survives APK signing.
//
// `sha256sum app-release.apk` differs between two builds of one commit even when
// every file inside is identical: APK Signature Scheme v2/v3 signs a *salted*
// digest, and the 32-byte salt is random per signing run. This script hashes what
// the build actually produced — every zip entry's name, size, CRC-32 and the
// stored modification time — and ignores the signing block.
//
//   node app/scripts/apk-content-hash.mjs app/build/outputs/apk/release/app-release.apk
//
// Two builds of the same commit with the same toolchain print the same value.
// See docs/REPRODUCIBLE-BUILD.md.
import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error("usage: node app/scripts/apk-content-hash.mjs <path-to.apk>");
  process.exit(2);
}

const buf = fs.readFileSync(file);
const rows = [];

// Walk the central directory: it carries the CRC and time stored with each entry.
const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06"));
if (eocd < 0) {
  console.error(`${file}: not a zip/apk (no end-of-central-directory record)`);
  process.exit(1);
}
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) {
    console.error(`${file}: central directory is malformed at ${p}`);
    process.exit(1);
  }
  const time = buf.readUInt16LE(p + 12);
  const date = buf.readUInt16LE(p + 14);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nLen = buf.readUInt16LE(p + 28);
  const eLen = buf.readUInt16LE(p + 30);
  const cLen = buf.readUInt16LE(p + 32);
  const name = buf.toString("utf8", p + 46, p + 46 + nLen);
  rows.push(`${name}\t${usize}\t${csize}\t${crc.toString(16)}\t${date.toString(16)}:${time.toString(16)}`);
  p += 46 + nLen + eLen + cLen;
}

rows.sort();
const digest = crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
console.log(`${digest}  ${count} entries  ${file}`);
