// Cleanup pass v3: features/mux/tmux/relay (extra imports between std ones)
// and qr (connect body with JSON-parse fallback). Run once, then delete.
import fs from "node:fs";
import path from "node:path";

const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HARNESS_START = "let failures = [];";
const HARNESS_END = 'for (const sig of ["exit", "SIGINT", "SIGTERM"]) {\n  process.on(sig, () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });\n}\n';
const CONNECT_END = "    close: () => new Promise((res) => { ws.close(); setTimeout(res, 100); }),\n  };\n}\n";

function stripBlocks(src) {
  const hStart = src.indexOf(HARNESS_START);
  const hEnd = src.indexOf(HARNESS_END, hStart);
  if (hStart !== -1 && hEnd !== -1) src = src.slice(0, hStart) + src.slice(hEnd + HARNESS_END.length);
  const cStart = src.indexOf("function connect(port) {");
  const cEnd = src.indexOf(CONNECT_END, cStart);
  if (cStart !== -1 && cEnd !== -1) src = src.slice(0, cStart) + src.slice(cEnd + CONNECT_END.length);
  return src;
}

function commonRewrites(src) {
  src = src.replace(/^const REPO = [^\n]*\n/m, "");
  src = src.replace(/^const tmp = fs\.mkdtempSync\([^\n]*\n/m, "");
  src = src.replace(/^fs\.writeFileSync\(path\.join\(tmp, "node\.json"\)[^\n]*\n/m, "");
  src = src.replace(/const c = connect\(PORT\);\n  await new Promise\(\(res, rej\) => \{ c\.ws\.on\("open", res\); c\.ws\.on\("error", rej\); \}\);\n {2}c\.send\(\{ type: "hello", token: TOKEN \}\);\n {2}await c\.next\(\(m\) => m\.type === "welcome"\);/g,
    "const c = await openAndHello(PORT, TOKEN);");
  src = src.replace(/startDaemon\(PORT, CLI_PORT\)/g, "startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp })");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGTERM"\); \} catch \{\} \}\n {2}await new Promise\(\(r\) => setTimeout\(r, 1200\)\);\n {2}try \{ fs\.rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{\}/g, "  await teardown(tmp);");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGTERM"\); \} catch \{\} \}\n {2}await new Promise\(\(r\) => setTimeout\(r, 1200\)\);\n {2}fs\.rmSync\(tmp, \{ recursive: true, force: true \}\);/g, "  await teardown(tmp);");
  src = src.replace(/ {2}if \(failures\.length\) \{\n {4}console\.error\(`FAILED: \$\{failures\.length\} — \$\{failures\.join\("; "\)\}`\);\n {4}process\.exit\(1\);\n {2}\}\n {2}console\.log\("ALL PASS"\);/g, "  finish();");
  src = src.replace(/\n\n\n+/g, "\n\n");
  return src;
}

for (const f of ["features.test.mjs", "mux.test.mjs", "tmux.test.mjs", "relay.test.mjs"]) {
  const p = path.join(dir, f);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes("test/helpers.mjs")) { console.log("skip:", f); continue; }

  // Remove the standard five imports; keep whatever else (net, execSync, module imports).
  src = src.replace(/^import fs from "node:fs";\n/m, "");
  src = src.replace(/^import os from "node:os";\n/m, "");
  src = src.replace(/^import path from "node:path";\n/m, "");
  src = src.replace(/^import \{ spawn \} from "node:child_process";\n/m, "");
  src = src.replace(/^import \{ spawn, execSync \} from "node:child_process";\n/m, "import { execSync } from \"node:child_process\";\n");
  src = src.replace(/^import \{ execFileSync, spawn \} from "node:child_process";\n/m, "import { execFileSync } from \"node:child_process\";\n");
  src = src.replace(/^import WebSocket from "ws";\n/m, "");
  src = 'import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";\nimport fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\n' + src;

  src = stripBlocks(src);
  src = commonRewrites(src);
  // tmp declaration
  src = src.replace(/^(const PORT = \d+;)/m, 'const tmp = makeTmp("rh-' + f.replace(".test.mjs", "") + '-");\n\n$1');

  fs.writeFileSync(p, src);
  console.log("rewritten:", f);
}

// qr.test.mjs: connect body has a JSON-try/catch wrapper — match its exact tail.
{
  const p = path.join(dir, "qr.test.mjs");
  let src = fs.readFileSync(p, "utf8");
  if (!src.includes("test/helpers.mjs")) {
    src = src.replace(/^import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport \{ spawn \} from "node:child_process";\nimport WebSocket from "ws";\n/m,
      'import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";\n');
    src = stripBlocks(src);
    src = commonRewrites(src);
    src = src.replace(/^(const PORT = \d+;)/m, 'const tmp = makeTmp("rh-qr-");\n\n$1');
    fs.writeFileSync(p, src);
    console.log("rewritten: qr.test.mjs");
  } else console.log("skip: qr.test.mjs");
}
console.log("done");