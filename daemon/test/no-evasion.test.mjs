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

// The owner ruled on 2026-11-26 that the AMSI explanation stays: `2ec01a0`
// restored these passages verbatim from `e6da7a5^`, so the rule keeps the
// framing and exempts exactly these lines, one by one. A hit passes only when
// its trimmed text equals a listed line for that same file.
const RESTORED = new Map([
  ["daemon/src/desktop/capture.js", ["// 40-69 = 75%, below = 50%. In-memory JPEG keeps AMSI calm — the"]],
  [
    "daemon/src/desktop_capture.js",
    ["* Windows AMSI blocks any single script combining SendInput P/Invoke WITH"],
  ],
  [
    "docs/EXCLUSIVE-FULLSCREEN.md",
    [
      "must stay invisible to anti-cheat and antivirus (its capture helpers are already written to avoid the",
      "RAT heuristics AMSI flags). Every other route is the OS saying no.",
    ],
  ],
  [
    "docs/FEATURE-MATRIX.md",
    [
      "| **Real desktop control (capture + input)** | rustdesk, anydesk | ✅ `desktop_start/stop/frame/mouse/key/type/quality/status` — Windows PowerShell helpers (warm ~3 fps JPEG capture in-memory to dodge AMSI RAT heuristics + warm SendInput input helper), canvas viewer in the browser tab (click/right-click/wheel/keyboard), watcher-scoped frame feed (no broadcast fan-out), capture loop stops at zero viewers; browser 🖨️ Desktop tab + relay status pill + 🔔 Test-push button |",
    ],
  ],
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
const exempted = [];
for (const file of files) {
  const rel = path.relative(REPO, file).replace(/\\/g, "/");
  if (ALLOWED.has(rel)) continue;
  const restored = RESTORED.get(rel) || [];
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!BANNED.some((re) => re.test(line))) return;
    if (restored.includes(trimmed)) exempted.push(`${rel}:${i + 1}`);
    else hits.push(`${rel}:${i + 1} ${trimmed.slice(0, 120)}`);
  });
}
check(
  `no doc or comment claims PocketDesk evades detection${hits.length ? ": " + hits.join(" | ") : ""}`,
  hits.length === 0,
);

// The exemption cannot rot into a blanket: every listed path still exists, every
// listed line is still in that file, and the exempted hits are exactly those lines.
for (const [rel, listedLines] of RESTORED) {
  const file = path.join(REPO, rel);
  const present = fs.existsSync(file);
  check(`RESTORED path exists: ${rel}`, present);
  const fileLines = present
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
    : [];
  for (const line of listedLines) {
    check(`RESTORED line still in ${rel}: ${line.slice(0, 70)}`, fileLines.includes(line));
  }
}
const listed = [...RESTORED.values()].reduce((n, ls) => n + ls.length, 0);
check(
  `the exempted hits are exactly the ${listed} restored lines (${exempted.length}: ${exempted.join(", ")})`,
  exempted.length === listed,
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
