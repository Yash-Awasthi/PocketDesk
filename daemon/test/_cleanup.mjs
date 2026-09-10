// Cleanup pass over the already-rewritten test files:
// 1. drop leftover REPO/tmp-setup lines (helpers owns those now)
// 2. re-add node/ws imports that each file's body actually uses
// 3. add missing makeTmp/openAndHello to the helpers import if needed
// Run once, then delete.
import fs from "node:fs";
import path from "node:path";

const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));

for (const f of files) {
  const p = path.join(dir, f);
  let src = fs.readFileSync(p, "utf8");
  if (!src.includes("test/helpers.mjs")) continue;
  const before = src;

  // 1. Remove leftover REPO line + tmp creation block (variants).
  src = src.replace(/const REPO = [^\n]+\n/g, "");
  src = src.replace(/const tmp = fs\.mkdtempSync\([^\n]+\n/g, "");
  src = src.replace(/fs\.writeFileSync\(path\.join\(tmp, "node\.json"\)[^\n]+\n/g, "");

  // 2. Replace tmp usages with makeTmp (only where declared/removed above).
  //    The file no longer has `tmp` — find its old prefix from "rh-xxx-".
  const prefixMatch = before.match(/rh-([a-z0-9]+)-/);
  const prefix = prefixMatch ? prefixMatch[1] : "gen";
  if (!/\bconst tmp = makeTmp\(/.test(src) && /(?<![\w.])tmp\b/.test(src)) {
    // insert declaration after the helpers import line
    src = src.replace(/(import \{[^}]+\} from "\.\/helpers\.mjs";\n)/,
      `$1\nconst tmp = makeTmp("rh-${prefix}-");\n`);
  }

  // 3. Import line surgery: ensure needed names present, drop unused ones.
  const imp = src.match(/import \{([^}]+)\} from "\.\/helpers\.mjs";/);
  if (imp) {
    const names = imp[1].split(",").map((s) => s.trim()).filter(Boolean);
    const needed = names.filter((n) => {
      if (n === "check") return /(?<![\w.])check\(/.test(src);
      if (n === "connectRaw") return /(?<![\w.])connectRaw\(/.test(src);
      if (n === "finish") return /(?<![\w.])finish\(\)/.test(src);
      if (n === "makeTmp") return /(?<![\w.])makeTmp\(/.test(src);
      if (n === "openAndHello") return /(?<![\w.])openAndHello\(/.test(src);
      if (n === "startDaemon") return /(?<![\w.])startDaemon\(/.test(src);
      if (n === "teardown") return /(?<![\w.])teardown\(/.test(src);
      if (n === "connect") return /(?<![\w.])connect\(/.test(src);
      return true;
    });
    // Add anything the body uses but the import lacks.
    for (const want of ["check", "connect", "connectRaw", "finish", "makeTmp", "openAndHello", "startDaemon", "teardown"]) {
      const used = new RegExp(`(?<![\\w.])${want}\\(`).test(src);
      if (used && !needed.includes(want)) needed.push(want);
    }
    src = src.replace(imp[0], `import { ${needed.sort().join(", ")} } from "./helpers.mjs";`);
  }

  // 4. Re-add node/ws imports the body still uses.
  const adds = [];
  if (/(?<![\w.])fs\./.test(src)) adds.push('import fs from "node:fs";');
  if (/(?<![\w.])os\./.test(src)) adds.push('import os from "node:os";');
  if (/(?<![\w.])path\./.test(src)) adds.push('import path from "node:path";');
  if (/(?<![\w.])WebSocket\b/.test(src)) adds.push('import WebSocket from "ws";');
  if (adds.length) {
    src = src.replace(/(import \{[^}]+\} from "\.\/helpers\.mjs";\n)/, `$1${adds.join("\n")}\n`);
  }

  if (src !== before) {
    fs.writeFileSync(p, src);
    console.log("cleaned:", f);
  }
}
console.log("cleanup done");