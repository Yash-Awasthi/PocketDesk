// The threat model is a paper, so the checks are about shape and real control names:
// seven threats in order, the same three labels in each, no placeholder text, ASCII only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// This file lives in daemon/test; docs sits beside daemon/, so resolve ../../docs from here.
const DOC_PATH = path.resolve(import.meta.dirname, "..", "..", "docs", "THREAT-MODEL.md");
const doc = fs.readFileSync(DOC_PATH, "utf8");

const THREATS = [
  "lan attacker",
  "stolen phone",
  "revoked-but-cached token",
  "malicious qr",
  "iroh relay",
  "local unprivileged user",
  "paper",
];
const LABELS = ["**Capability today**", "**Control**", "**Residual risk**"];
const CONTROLS = [
  ["timingSafeEqual", /timingsafeequal/i],
  ["device token", /device token/i],
  ["claimEndpoint", /claimendpoint/i],
  ["revoke", /revoke/i],
  ["totp", /totp/i],
  ["TLS fingerprint", /tls fingerprint/i],
  ["pin", /\bpin/i],
  ["iroh endpoint id", /iroh endpoint id/i],
  ["loopback", /loopback/i],
];

/** The numbered sections, in document order, with the heading text and body. */
function threatSections(text) {
  const out = [];
  for (const chunk of text.split(/^## /m).slice(1)) {
    const [heading, ...rest] = chunk.split("\n");
    const m = heading.match(/^(\d+)\.\s+(.+)$/);
    if (!m) continue;
    out.push({ number: Number(m[1]), name: m[2].trim(), body: rest.join("\n") });
  }
  return out;
}

const sections = threatSections(doc);

test("the seven threat headings exist in the required order", () => {
  assert.equal(sections.length, THREATS.length, `expected ${THREATS.length} numbered threat sections, found ${sections.length}`);
  assert.deepEqual(sections.map((s) => s.name.toLowerCase()), THREATS);
  assert.deepEqual(sections.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7]);
});

test("every threat section has exactly Capability today, Control and Residual risk", () => {
  for (const section of sections) {
    const found = section.body.match(/\*\*[^*]+\*\*/g) ?? [];
    assert.deepEqual(found, LABELS, `${section.name}: labels are ${JSON.stringify(found)}`);
    let cursor = -1;
    for (const label of LABELS) {
      const at = section.body.indexOf(label);
      assert.ok(at > cursor, `${section.name}: ${label} is missing or out of order`);
      cursor = at;
      const after = section.body.slice(at + label.length).trim();
      assert.ok(after.length > 0, `${section.name}: ${label} has no text`);
    }
  }
});

test("the document names the real controls", () => {
  for (const [name, re] of CONTROLS) {
    assert.match(doc, re, `threat model never names ${name}`);
  }
});

test("there is no TODO, TBD or FIXME placeholder", () => {
  assert.doesNotMatch(doc, /\b(TODO|TBD|FIXME)\b/);
});

test("the document is ASCII only", () => {
  const bad = [...doc].filter((c) => c.codePointAt(0) > 0x7f);
  assert.equal(bad.length, 0, `non-ASCII characters: ${bad.map((c) => JSON.stringify(c)).join(", ")}`);
});
