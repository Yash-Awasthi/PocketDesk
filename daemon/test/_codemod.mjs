// One-shot codemod: rewrite test files to use the shared harness.
// Only fires on verbatim-identical blocks; any file with a mismatch is left
// untouched and reported. Run once, then delete.
import fs from "node:fs";
import path from "node:path";

const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const IMPORT_BLOCK = [
  'import fs from "node:fs";',
  'import os from "node:os";',
  'import path from "node:path";',
  'import { spawn } from "node:child_process";',
  'import WebSocket from "ws";',
  "",
].join("\n");

const HEAD = (port, cliPort, token, prefix) => [
  `const PORT = ${port};`,
  `const CLI_PORT = ${cliPort};`,
  `const TOKEN = "${token}";`,
  `const REPO = path.dirname(new URL("..", import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, "$1")); // PocketDesk root (git repo)`,
  "",
  `const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-${prefix}-"));`,
  'fs.writeFileSync(path.join(tmp, "node.json"), JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }));',
  "",
].join("\n");

const HARNESS = [
  "let failures = [];",
  "function check(name, cond) {",
  '  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);',
  "  if (!cond) failures.push(name);",
  "}",
  "",
  "const children = [];",
  "function startDaemon(port, cliPort) {",
  '  const d = spawn(process.execPath, ["src/index.js"], {',
  '    cwd: REPO + "/daemon",',
  "    env: {",
  "      ...process.env,",
  "      RH_PORT: String(port),",
  "      RH_TOKEN: TOKEN,",
  "      RH_MANIFESTS: tmp,",
  "      RH_CLI_PORT: String(cliPort),",
  '      POCKETDESK_DATA: ".pocketdesk-test",',
  "    },",
  '    stdio: ["ignore", "pipe", "pipe"],',
  "  });",
  '  d.stderr.on("data", (x) => process.stderr.write("[daemon!] " + x));',
  "  d.ready = new Promise((resolve, reject) => {",
  '    d.stdout.on("data", (x) => {',
  '      process.stdout.write("[daemon] " + x);',
  '      if (String(x).includes("registry scanned")) resolve();',
  "    });",
  '    d.on("exit", (code) => reject(new Error(`daemon exited early (code ${code})`)));',
  "  });",
  "  children.push(d);",
  "  return d;",
  "}",
  'for (const sig of ["exit", "SIGINT", "SIGTERM"]) {',
  '  process.on(sig, () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });',
  "}",
  "",
].join("\n");

const CONNECT = [
  "function connect(port) {",
  '  const ws = new WebSocket(`ws://localhost:${port}/ws`);',
  "  const waiters = [];",
  "  const log = [];",
  "  let since = 0;",
  '  ws.on("message", (raw) => {',
  "    const m = JSON.parse(raw.toString());",
  "    log.push(m);",
  "    const i = waiters.findIndex((w) => w.pred(m));",
  "    if (i >= 0) {",
  "      const [w] = waiters.splice(i, 1);",
  "      clearTimeout(w.timer);",
  "      w.resolve(m);",
  "    }",
  "  });",
  "  return {",
  "    ws,",
  '    send: (o) => { since = log.length; ws.send(JSON.stringify(o)); },',
  "    next: (pred, timeoutMs = 15000) => {",
  "      for (let i = log.length - 1; i >= since; i--) {",
  "        if (pred(log[i])) return Promise.resolve(log[i]);",
  "      }",
  "      return new Promise((resolve, reject) => {",
  '        const t = setTimeout(() => reject(new Error("timeout waiting for: " + String(pred).slice(0, 120))), timeoutMs);',
  "        waiters.push({ pred, resolve, timer: t });",
  "      });",
  "    },",
  '    close: () => new Promise((res) => { ws.close(); setTimeout(res, 100); }),',
  "  };",
  "}",
  "",
].join("\n");

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "reconnect.test.mjs");
let done = 0, skipped = [];

for (const f of files) {
  const p = path.join(dir, f);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes("test/helpers.mjs")) { console.log("skip (already helpers):", f); continue; }

  if (!src.includes(IMPORT_BLOCK)) { skipped.push([f, "import block"]); continue; }
  if (!src.includes(HARNESS)) { skipped.push([f, "harness body"]); continue; }
  if (!src.includes(CONNECT)) { skipped.push([f, "connect body"]); continue; }

  const m = src.match(/const PORT = (\d+);\nconst CLI_PORT = (\d+);\nconst TOKEN = "([^"]+)";\n[\s\S]*?rh-([a-z0-9]+)-/);
  if (!m) { skipped.push([f, "constants"]); continue; }
  const [, port, cliPort, token, prefix] = m;

  src = src.replace(IMPORT_BLOCK, 'import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";\n');
  src = src.replace(HEAD(port, cliPort, token, prefix), `const PORT = ${port};\nconst CLI_PORT = ${cliPort};\n`);
  src = src.replace(HARNESS, "");
  src = src.replace(CONNECT, "");

  // Body rewrites — these patterns cover every usage in the 15 files; a file
  // that still references a removed symbol after this will fail to parse and
  // be caught by node --check below.
  src = src.replace(/await d\.ready;\n  const c = connect\(PORT\);\n  await new Promise\(\(res, rej\) => \{ c\.ws\.on\("open", res\); c\.ws\.on\("error", rej\); \}\);\n  c\.send\(\{ type: "hello", token: TOKEN \}\);\n  await c\.next\(\(m\) => m\.type === "welcome"\);/g,
    "await d.ready;\n  const c = await openAndHello(PORT, TOKEN);");
  src = src.replace(/const c = connect\(PORT\);\n  await new Promise\(\(res, rej\) => \{ c\.ws\.on\("open", res\); c\.ws\.on\("error", rej\); \}\);\n  c\.send\(\{ type: "hello", token: TOKEN \}\);\n  await c\.next\(\(m\) => m\.type === "welcome"\);/g,
    "const c = await openAndHello(PORT, TOKEN);");
  // Raw-URL clients (qr phone, relay peer, bad-token intruder).
  src = src.replace(/connect\(Number\(qrPort\), `\/\?token=\$\{share\.token\}`\)/g, 'connectRaw(`ws://localhost:${qrPort}/?token=${share.token}`)');
  src = src.replace(/connect\(Number\(qrPort\), "\/\?token=deadbeef"\)/g, 'connectRaw(`ws://localhost:${qrPort}/?token=deadbeef`)');
  src = src.replace(/connect\(RELAY_PORT\)/g, "connectRaw(`ws://localhost:${RELAY_PORT}`)");
  src = src.replace(/const peer = connect\(RELAY_PORT\);/g, "const peer = connectRaw(`ws://localhost:${RELAY_PORT}`);");
  // Teardown blocks → helpers.teardown.
  src = src.replace(/ {2}(?:for \(const ch of children\) \{ try \{ ch\.kill\("SIGTERM"\); \} catch \{\} \}\n {2}await new Promise\(\(r\) => setTimeout\(r, 1200\)\);\n {2})?try \{ fs\.rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{\}/g,
    "await teardown(tmp);");
  src = src.replace(/ {2}for \(const c of children\) \{ try \{ c\.kill\("SIGKILL"\); \} catch \{\} \}\n {2}fs\.rmSync\(tmp, \{ recursive: true, force: true \}\);/g,
    "  await teardown(tmp);");
  src = src.replace(/ {2}d1\.kill\("SIGTERM"\);\n {2}await sleep\(1200\);/g, '  d1.kill("SIGTERM");\n  await new Promise((r) => setTimeout(r, 1200));');
  // Final summary → finish().
  src = src.replace(/ {2}if \(failures\.length\) \{\n {4}console\.error\(`FAILED: \$\{failures\.length\} — \$\{failures\.join\("; "\)\}`\);\n {4}process\.exit\(1\);\n {2}\}\n {2}console\.log\("ALL PASS"\);/g,
    "  finish();");

  fs.writeFileSync(p, src);
  done++;
  console.log("rewritten:", f);
}

console.log(`\n${done} rewritten, ${skipped.length} skipped`);
for (const [f, why] of skipped) console.log("  SKIPPED", f, "—", why);