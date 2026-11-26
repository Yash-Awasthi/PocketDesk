#!/usr/bin/env node
// Keeps daemon/protocol/compat.json in step with the documented protocol and enforces the rule in
// docs/adr/0001-protocol-changes.md: a new message is additive, a removed or changed one needs a
// version bump plus a note naming it.
//
//   node daemon/scripts/gen-protocol-compat.mjs           # accept additions into the baseline
//   node daemon/scripts/gen-protocol-compat.mjs --check   # exit 1 when the baseline is stale
//
// daemon/test/protocol-doc.test.mjs runs the --check form.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.dirname(HERE);
const REPO = path.dirname(DAEMON);
const README = path.join(REPO, "README.md");
const TABLE = path.join(DAEMON, "README.md");
const BASELINE = path.join(DAEMON, "protocol", "compat.json");
const ADR = path.join(REPO, "docs", "adr", "0001-protocol-changes.md");

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function documentedVersion() {
  const m = /^## .*Protocol \(v(\d+)\)/m.exec(read(README));
  if (!m) throw new Error("no 'Protocol (vN)' heading in README.md");
  return Number(m[1]);
}

// The client-to-server list: everything between the two section markers.
function clientBlock() {
  const text = read(README);
  const start = text.indexOf("**Client \u2192 Server:**");
  const end = text.indexOf("**Server \u2192 Client:**");
  if (start < 0 || end < 0 || end < start) throw new Error("client-to-server list not found in README.md");
  return text.slice(start, end);
}

// Message name -> the field list the README documents for it ("" when it documents none).
function documentedFields() {
  const out = new Map();
  const re = /`([a-z][a-z0-9_]*)(?:\s*\{([^}]*)\})?`(?:\/([a-z][a-z0-9_]*))?/g;
  for (const m of clientBlock().matchAll(re)) {
    const fields = (m[2] || "").trim();
    out.set(m[1], fields);
    if (m[3]) out.set(m[3], fields);
  }
  return out;
}

// Every message the generated table lists, which is every type the daemon answers.
function tableTypes() {
  return read(TABLE)
    .split("\n")
    .filter((l) => /^\| `[a-z0-9_]+` \| `src\/[a-z_/.]+` \|$/.test(l))
    .map((r) => r.split("`")[1]);
}

function current() {
  const fields = documentedFields();
  const messages = {};
  for (const type of tableTypes().sort()) messages[type] = fields.get(type) || "";
  return { protocolVersion: documentedVersion(), messages };
}

function notes() {
  const out = new Map();
  for (const m of read(ADR).matchAll(/^- v(\d+): (.+)$/gm)) {
    const at = out.get(Number(m[1])) || [];
    at.push(m[2]);
    out.set(Number(m[1]), at);
  }
  return out;
}

function compare(base, cur) {
  return {
    added: Object.keys(cur).filter((t) => !(t in base)),
    removed: Object.keys(base).filter((t) => !(t in cur)),
    changed: Object.keys(base).filter((t) => t in cur && base[t] !== cur[t]),
  };
}

function main() {
  const check = process.argv.includes("--check");
  const cur = current();
  if (check && !fs.existsSync(BASELINE)) {
    console.error("gen-protocol-compat: daemon/protocol/compat.json is missing");
    process.exit(1);
  }
  const base = fs.existsSync(BASELINE) ? JSON.parse(read(BASELINE)) : { protocolVersion: 0, messages: {} };
  const { added, removed, changed } = compare(base.messages, cur.messages);

  // A removal or a field change breaks a client that already shipped, so it needs both a new
  // version and a note that names the message it affects.
  const breaking = [...removed, ...changed];
  if (breaking.length) {
    const bumped = cur.protocolVersion > base.protocolVersion;
    const at = notes().get(cur.protocolVersion) || [];
    const unmentioned = breaking.filter((t) => !at.some((line) => line.includes(t)));
    if (!bumped || unmentioned.length) {
      console.error(
        `gen-protocol-compat: ${breaking.length} message(s) removed or changed without a version bump and a compatibility note: ${breaking.join(", ")}`,
      );
      if (!bumped)
        console.error(
          `  current protocol v${cur.protocolVersion} is not above the baseline v${base.protocolVersion}`,
        );
      if (unmentioned.length)
        console.error(
          `  no v${cur.protocolVersion} note in docs/adr/0001-protocol-changes.md names: ${unmentioned.join(", ")}`,
        );
      process.exit(1);
    }
  }

  if (check && cur.protocolVersion !== base.protocolVersion) {
    console.error(
      `gen-protocol-compat: the baseline records v${base.protocolVersion} but README.md declares v${cur.protocolVersion} ? run: node daemon/scripts/gen-protocol-compat.mjs`,
    );
    process.exit(1);
  }

  if (check && added.length) {
    console.error(
      `gen-protocol-compat: new message(s) ${added.join(", ")} are additive, so no version bump is needed, but the baseline is stale, run: node daemon/scripts/gen-protocol-compat.mjs`,
    );
    process.exit(1);
  }

  if (check) {
    console.log(
      `compatibility baseline is current (${Object.keys(cur.messages).length} messages, protocol v${cur.protocolVersion})`,
    );
    return;
  }

  const next = {
    _comment:
      "Baseline for docs/adr/0001-protocol-changes.md: message -> the field list README.md documents. Regenerate with node daemon/scripts/gen-protocol-compat.mjs; a removal or a changed field list needs a protocol version bump and a vN note in that ADR.",
    protocolVersion: cur.protocolVersion,
    messages: cur.messages,
  };
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `wrote ${Object.keys(cur.messages).length} messages at protocol v${cur.protocolVersion} to daemon/protocol/compat.json`,
  );
}

main();
