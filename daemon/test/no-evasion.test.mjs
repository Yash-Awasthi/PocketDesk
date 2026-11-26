// The contribution rule from docs/INTEGRITY.md P4, enforced: this tool stays
// visible to the machine it runs on. Any doc, comment or script that markets it
// as undetectable is a bug, not copy. Two files may discuss the topic because
// their job is to name and forbid it: docs/INTEGRITY.md and plan.md.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";
import { Webcam } from "../src/webcam.js";
import { fitLabel, labelFor, stamp } from "../src/watermark.js";

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
const ALLOWED = new Set([
  "docs/INTEGRITY.md",
  "plan.md",
  "CONTRIBUTING.md",
  "daemon/test/no-evasion.test.mjs",
]);
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
check(
  `no doc or comment claims PocketDesk evades detection${hits.length ? ": " + hits.join(" | ") : ""}`,
  hits.length === 0,
);

// The rule has to be findable where a contributor reads it.
const contributing = fs.readFileSync(path.join(REPO, "CONTRIBUTING.md"), "utf8");
check("CONTRIBUTING.md links docs/INTEGRITY.md", /docs\/INTEGRITY\.md/.test(contributing));
check("CONTRIBUTING.md states the no-evasion rule", /detection-evasion/i.test(contributing));
check(
  "CONTRIBUTING.md carries the grep-able banned-pattern check",
  /no-evasion\.test\.mjs/.test(contributing),
);

const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
check("README has a Responsible use section", /^### Responsible use$/m.test(readme));
check("README prohibits proctored use", /proctored assessment/i.test(readme));
check("README links docs/INTEGRITY.md", /docs\/INTEGRITY\.md/.test(readme));

// The same rule in the frame: the virtual webcam is off until someone asks for it, and every
// frame it does publish names the phone and the UTC time, so a recording shows both.
{
  const cam = new Webcam();
  check(
    "the virtual webcam starts off, with no helper process and no decoder",
    cam.state === "off" && !cam.vcam && !cam.ff,
  );

  const label = labelFor("Pixel 8", new Date("2026-11-26T09:07:05.123Z"));
  check(`the mark is the phone name and the UTC clock (${label})`, label === "Pixel 8 2026-11-26T09:07:05Z");
  check("an unnamed phone still gets a mark", labelFor("", new Date(0)) === "Phone 1970-01-01T00:00:00Z");
  const cut = fitLabel("X".repeat(200), 320, 1);
  check("a long mark is cut to what the frame holds", cut === "X".repeat(50));
  check("a frame too small for the mark is left alone", stamp(Buffer.alloc(16 * 8 * 4), 16, 8, label) === "");

  const W = 320;
  const H = 240;
  cam.name = "Pixel 8";
  const frame = Buffer.alloc(W * H * 4, 120);
  check("markFrame returns the same buffer", cam.markFrame(frame, W, H) === frame);
  check("the untouched top corner stays as it was", frame.readUInt32LE(0) === 0x78787878);
  let white = 0;
  let stripped = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] === 255 && frame[i + 1] === 255 && frame[i + 2] === 255) white++;
    else if (frame[i] < 60 && frame[i + 1] < 60 && frame[i + 2] < 60) stripped++;
  }
  check(`the mark draws glyphs (${white} white pixels)`, white > 100);
  check(`the mark sits on a darkened strip (${stripped} dark pixels)`, stripped > 1000);
  const webcamSource = fs.readFileSync(path.join(REPO, "daemon/src/webcam.js"), "utf8");
  check(
    "every decoded frame goes through markFrame",
    /this\.markFrame\(frame, width, height\)/.test(webcamSource),
  );
}

finish();
