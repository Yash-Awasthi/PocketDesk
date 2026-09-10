// Cleanup pass v2 for the remaining files: agents, digest, features, mux, qr,
// tmux, relay. Rewrites their slightly-different harnesses onto helpers.
// Run once, then delete.
import fs from "node:fs";
import path from "node:path";

const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files = ["agents.test.mjs", "digest.test.mjs", "features.test.mjs", "mux.test.mjs", "qr.test.mjs", "tmux.test.mjs", "relay.test.mjs"];

const HARNESS_START = "let failures = [];";
const HARNESS_END = 'for (const sig of ["exit", "SIGINT", "SIGTERM"]) {\n  process.on(sig, () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });\n}\n';

const CONNECT_START = "function connect(port) {";
const CONNECT_END = "    close: () => new Promise((res) => { ws.close(); setTimeout(res, 100); }),\n  };\n}\n";

for (const f of files) {
  const p = path.join(dir, f);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes("test/helpers.mjs")) { console.log("skip:", f); continue; }
  const orig = src;

  // 1. Replace import block: drop fs/os/path/spawn/WebSocket imports; keep any
  //    extra imports (e.g. TerminalRenderer) by capturing lines after the
  //    standard five.
  const stdImports = /^import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport \{ spawn \} from "node:child_process";\nimport WebSocket from "ws";\n/m;
  if (!stdImports.test(src)) { console.log("SKIP (imports):", f); continue; }
  src = src.replace(stdImports, "");
  const helpersImport = 'import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";\n';
  src = helpersImport + src;

  // 2. Constants: drop REPO/tmp lines; keep PORT/CLI_PORT/TOKEN.
  src = src.replace(/^const REPO = [^\n]*\n/m, "");
  src = src.replace(/^const tmp = fs\.mkdtempSync\([^\n]*\n/m, "");
  src = src.replace(/^fs\.writeFileSync\(path\.join\(tmp, "node\.json"\)[^\n]*\n/m, "");
  // tmp declaration via makeTmp after imports
  src = src.replace(/^(const PORT = \d+;)/m, 'const tmp = makeTmp("rh-' + f.replace(".test.mjs", "") + '-");\n\n$1');

  // 3. Remove the harness block (failures → check → children → startDaemon → sig handlers).
  const hStart = src.indexOf(HARNESS_START);
  const hEnd = src.indexOf(HARNESS_END, hStart);
  if (hStart === -1 || hEnd === -1) { console.log("SKIP (harness):", f); continue; }
  src = src.slice(0, hStart) + src.slice(hEnd + HARNESS_END.length);

  // 4. Remove the connect() block (it spans from CONNECT_START to CONNECT_END).
  const cStart = src.indexOf(CONNECT_START);
  const cEnd = src.indexOf(CONNECT_END, cStart);
  if (cStart === -1 || cEnd === -1) { console.log("SKIP (connect):", f); continue; }
  src = src.slice(0, cStart) + src.slice(cEnd + CONNECT_END.length);

  // 5. Body: hello handshake → openAndHello.
  src = src.replace(/const c = connect\(PORT\);\n  await new Promise\(\(res, rej\) => \{ c\.ws\.on\("open", res\); c\.ws\.on\("error", rej\); \}\);\n  c\.send\(\{ type: "hello", token: TOKEN \}\);\n  await c\.next\(\(m\) => m\.type === "welcome"\);/g,
    "const c = await openAndHello(PORT, TOKEN);");
  src = src.replace(/const c = connect\(PORT\);\n  await new Promise\(\(res, rej\) => \{ c\.ws\.on\("open", res\); c\.ws\.on\("error", rej\); \}\);\n {2}c\.send\(\{ type: "hello", token: TOKEN \}\);/g,
    "const c = await openAndHello(PORT, TOKEN);");

  // 6. startDaemon calls → pass token + manifests.
  src = src.replace(/startDaemon\(PORT, CLI_PORT\)/g, "startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp })");
  src = src.replace(/startDaemon\(PORT2, 46792\)/g, 'startDaemon(PORT2, 46792, { token: TOKEN, manifests: tmp })');
  src = src.replace(/startDaemon\(PORT, 46792\)/g, 'startDaemon(PORT, 46792, { token: TOKEN, manifests: tmp })');

  // 7. Teardown: SIGTERM + sleep + rmSync → teardown(tmp).
  src = src.replace(/ {2}d1\.kill\("SIGTERM"\);\n {2}await sleep\(1200\);/g, '  d1.kill("SIGTERM");\n  await new Promise((r) => setTimeout(r, 1200));');
  src = src.replace(/ {2}d2\.kill\("SIGTERM"\);\n {2}\/\/ cleanup test data dir in home\n {2}try \{ fs\.rmSync\(path\.join\(os\.homedir\(\), "\.pocketdesk-test"\), \{ recursive: true, force: true \}\); \} catch \{\}\n {2}try \{ fs\.rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{\}/g,
    "  d2.kill(\"SIGTERM\");\n  // cleanup test data dir in home\n  try { fs.rmSync(path.join(os.homedir(), \".pocketdesk-test\"), { recursive: true, force: true }); } catch {}\n  await teardown(tmp);");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGTERM"\); \} catch \{\} \}\n {2}await new Promise\(\(r\) => setTimeout\(r, 1200\)\);\n {2}try \{ fs\.rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{\}/g,
    "  await teardown(tmp);");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGTERM"\); \} catch \{\} \}\n {2}await new Promise\(\(r\) => setTimeout\(r, 1200\)\);\n {2}fs\.rmSync\(tmp, \{ recursive: true, force: true \}\);/g,
    "  await teardown(tmp);");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGKILL"\); \} catch \{\} \}\n {2}fs\.rmSync\(tmp, \{ recursive: true, force: true \}\);/g,
    "  await teardown(tmp);");
  src = src.replace(/ {2}for \(const ch of children\) \{ try \{ ch\.kill\("SIGKILL"\); \} catch \{\} \}\n {2}try \{ fs\.rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{\}/g,
    "  await teardown(tmp);");

  // 8. Final summary → finish().
  src = src.replace(/ {2}if \(failures\.length\) \{\n {4}console\.error\(`FAILED: \$\{failures\.length\} — \$\{failures\.join\("; "\)\}`\);\n {4}process\.exit\(1\);\n {2}\}\n {2}console\.log\("ALL PASS"\);/g, "  finish();");
  src = src.replace(/\n {2}console\.log\(failures\.length \? `\\n\$\{failures\.length\} FAILURE\(S\)` : "\\nALL PASS"\);\n {2}process\.exit\(failures\.length \? 1 : 0\);/g, "\n  finish();");

  // 9. Trim triple blank lines.
  src = src.replace(/\n\n\n+/g, "\n\n");

  fs.writeFileSync(p, src);
  console.log("rewritten:", f);
}
console.log("done");