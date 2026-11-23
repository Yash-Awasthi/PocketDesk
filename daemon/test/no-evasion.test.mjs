// The contribution rule from docs/INTEGRITY.md P4, enforced: this tool stays
// visible to the machine it runs on. Any doc, comment or script that markets it
// as undetectable is a bug, not copy. Two files may discuss the topic because
// their job is to name and forbid it: docs/INTEGRITY.md and plan.md.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const // Phrases that only appear when a document is selling evasion.
  BANNED = [
    /invisible to anti-?cheat/i,
    /invisible to antivirus/i,
    /avoid(s|ing)? the RAT heuristics/i,
    /\bAMS[A-Z]?\b/, // AMSI
    /undetectab/i,
    /hide from (task manager|enumeration|process (list|enumeration))/i,
    /evade (detection|antivirus|anti-?cheat)/i,
  ];

// Files whose job is to *name* the forbidden patterns, and this test itself.
const ALLOWED = new Set(["docs/INTEGRITY.md", "plan.md", "CONTRIBUTING.md", "daemon/test/no-evasion.test.mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".gradle", "build", "screenshots", ".freebuff"]);
const SCANNED = [".md", ".js", ".mjs", ".cs", ".ps1", ".kt"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (SCANNED.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const files = walk(REPO);
check(`scanned the tree (${files.length} files)`, files.length > 50);

const hits = [];
for (const file of files) {
  const rel = path.relative(REPO, file).replace(/\\/g, "/");
  if (ALLOWED.has(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const re of BANNED) if (re.test(line)) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 120)}`);
  });
}
check(`no doc or comment claims PocketDesk evades detection${hits.length ? ": " + hits.join(" | ") : ""}`, hits.length === 0);

// The rule has to be findable where a contributor reads it.
const contributing = fs.readFileSync(path.join(REPO, "CONTRIBUTING.md"), "utf8");
check("CONTRIBUTING.md links docs/INTEGRITY.md", /docs\/INTEGRITY\.md/.test(contributing));
check("CONTRIBUTING.md states the no-evasion rule", /detection-evasion/i.test(contributing));
check("CONTRIBUTING.md carries the grep-able banned-pattern check", /no-evasion\.test\.mjs/.test(contributing));

const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
check("README has a Responsible use section", /^### Responsible use$/m.test(readme));
check("README prohibits proctored use", /proctored assessment/i.test(readme));
check("README links docs/INTEGRITY.md", /docs\/INTEGRITY\.md/.test(readme));

finish();
