import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { generateSelfSignedCert } from "../src/tls-gen.js";

test("generated certificate parses, is self-signed and serves TLS pinned by fingerprint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-tls-"));
  const tls = { cert: path.join(dir, "tls", "cert.pem"), key: path.join(dir, "tls", "key.pem") };
  try {
    assert.equal(generateSelfSignedCert(tls, dir), true);
    const cert = new crypto.X509Certificate(fs.readFileSync(tls.cert));
    assert.equal(cert.verify(cert.publicKey), true);
    assert.equal(cert.checkIssued(cert), true);
    assert.match(cert.subjectAltName, /DNS:localhost/);
    assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.ok(new Date(cert.validTo) > new Date(Date.now() + 9 * 365 * 86_400_000));
    const pinned = fs.readFileSync(path.join(dir, "tls", "fingerprint.txt"), "utf8").trim();

    const server = https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, (_q, r) => r.end("ok"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const seen = await new Promise((resolve, reject) => {
        https.get({ host: "127.0.0.1", port: server.address().port, rejectUnauthorized: false }, (res) => {
          const fp = res.socket.getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
          res.resume();
          res.on("end", () => resolve(fp));
        }).on("error", reject);
      });
      assert.equal(seen, pinned);
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
