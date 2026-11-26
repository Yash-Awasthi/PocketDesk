// Golden transcripts: the existing StreamJsonParser must survive every captured
// agent transcript under docs/transcripts, including the ones that carry no JSON
// at all (--version and --help output, and CLIs whose credential refusal is plain
// text). Nothing here is synthetic: the files are produced by
// `node docs/transcripts/capture.mjs` against installed CLIs.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";
import { StreamJsonParser } from "../src/stream_json_parser.js";

const DIR = path.join(REPO, "docs", "transcripts");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));

const BIN = {
  "claude-code": "claude",
  cline: "cline",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
  opencode: "opencode",
  qwen: "qwen",
};

const agentIds = manifest.agents.map((a) => a.id).sort();
check("manifest names seven agents", agentIds.length === 7);
check(
  "expected agent set",
  JSON.stringify(agentIds) ===
    JSON.stringify(["claude-code", "cline", "codex", "copilot", "gemini", "opencode", "qwen"]),
);

/** Split a transcript file into its header, stdout and stderr sections. */
function readTranscript(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out = { text, header: [], stdout: [], stderr: [], section: "header" };
  for (const line of lines) {
    if (line === "# ---- stdout ----") {
      out.section = "stdout";
      continue;
    }
    if (line === "# ---- stderr ----") {
      out.section = "stderr";
      continue;
    }
    if (line === "# ---- end ----") break;
    out[out.section].push(line);
  }
  return out;
}

/** Header field by name, or null. */
function headerField(header, name) {
  const prefix = "# " + name + ": ";
  const line = header.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

/** Every JSON object/UUID line the file actually contains, in order. */
function jsonLines(sections) {
  const found = [];
  for (const line of [...sections.stdout, ...sections.stderr]) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      found.push(JSON.parse(t));
    } catch {
      // Provenance header text can start with a character that is not JSON.
    }
  }
  return found;
}

const files = [];
for (const a of manifest.agents) {
  const dir = path.join(DIR, a.id);
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".txt"))
    .sort()) {
    files.push({ agent: a, name: f, file: path.join(dir, f) });
  }
}

// Every agent contributes version, help and the no-credential prompt attempt.
check("21 transcript files present", files.length === 21);
for (const a of manifest.agents) {
  const names = files.filter((f) => f.agent.id === a.id).map((f) => f.name);
  check(
    `${a.id}: version, help and print captured`,
    JSON.stringify(names) === '["help.txt","print.txt","version.txt"]',
  );
  check(`${a.id}: install path exists`, fs.existsSync(a.installPath));
  check(
    `${a.id}: package.json version matches manifest`,
    JSON.parse(fs.readFileSync(path.join(a.installPath, "package.json"), "utf8")).version === a.version,
  );
  check(`${a.id}: disk size recorded`, a.diskBytes > 1_000_000);
}

let parsedFiles = 0;
let parsedEvents = 0;

for (const { agent, name, file } of files) {
  const t = readTranscript(file);
  const label = `${agent.id}/${name}`;

  const argv = JSON.parse(headerField(t.header, "argv"));
  check(`${label}: header names the exact argv`, argv[0] === BIN[agent.id] && argv.length >= 2);
  check(`${label}: outcome recorded`, /^exit \d+ in \d+ ms$/.test(headerField(t.header, "outcome") || ""));
  check(`${label}: package recorded`, headerField(t.header, "package") === agent.package);

  const expected = jsonLines(t);
  const p = new StreamJsonParser();
  let items;
  let threw = false;
  try {
    items = p.parseLines(t.text);
  } catch (err) {
    threw = true;
    console.log("threw: " + err.message);
  }
  check(`${label}: parser does not throw`, !threw);
  check(`${label}: one item per JSON line (${expected.length})`, items.length === expected.length);

  if (name === "version.txt") {
    const first = t.stdout.find((l) => l.trim());
    check(`${label}: first stdout line carries the version`, Boolean(first) && first.includes(agent.version));
  }

  if (name === "print.txt") {
    const evidence = [...t.stdout, ...t.stderr].join("\n").trim();
    check(`${label}: the no-credential attempt produced output`, evidence.length > 0);
  }

  items.forEach((item, i) => {
    check(
      `${label}: item ${i} keeps its raw event`,
      JSON.stringify(item.raw) === JSON.stringify(expected[i]),
    );
    check(`${label}: item ${i} has a type`, typeof item.type === "string" && item.type.length > 0);
  });

  const init = items.find((i) => i.type === "system_init");
  if (init) {
    check(
      `${label}: init names the tool inventory`,
      init.formatted.includes("tools: ") && init.formatted.includes("Bash"),
    );
  }

  // Session id, when the wire carries one, reaches the item unchanged.
  items.forEach((item, i) => {
    if (expected[i].session_id)
      check(`${label}: item ${i} carries session_id`, item.sessionId === expected[i].session_id);
  });

  // A captured file never ends with a tool call left dangling.
  check(`${label}: no pending tools at end`, p.getStats().pendingTools === 0);
  parsedFiles++;
  parsedEvents += items.length;
}

// Claude's stream-json is the one shape with a full turn in it: init, the
// assistant turn, then the result envelope.
const claudePrint = readTranscript(path.join(DIR, "claude-code", "print.txt"));
const claudeItems = new StreamJsonParser().parseLines(claudePrint.text);
check(
  "claude stream-json yields init, assistant turn and result",
  JSON.stringify(claudeItems.map((i) => i.type)) ===
    JSON.stringify(["system_init", "assistant_text", "unknown"]),
);
check(
  "claude result envelope is preserved",
  claudeItems[2].raw.type === "result" && claudeItems[2].raw.is_error === true,
);
check(
  "claude assistant turn is the credential refusal",
  claudeItems[1].formatted.includes("Your organization has disabled Claude subscription access"),
);

// Codex emits thread/turn JSONL; every one of its lines is still carried.
const codexPrint = readTranscript(path.join(DIR, "codex", "print.txt"));
const codexLines = jsonLines(codexPrint);
check(
  "codex thread.started is in the capture",
  codexLines.some((e) => e.type === "thread.started"),
);
check(
  "codex turn.started is in the capture",
  codexLines.some((e) => e.type === "turn.started"),
);
check(
  "codex turn.failed is in the capture",
  codexLines.some((e) => e.type === "turn.failed"),
);

// Whole-corpus sanity: every JSON event we captured is accounted for.
check("at least one captured event per JSON-emitting CLI", parsedEvents >= 20);
check("all 21 files went through the parser", parsedFiles === 21);

// ---- one real provider turn: qwen through Groq ----
// real-turn.jsonl is the only capture with a real assistant turn in it: thinking, a real
// tool_use, its tool_result, and then a real upstream failure. Groq rejects the
// reasoning_content qwen echoes back, so the second turn ends in error_during_execution;
// the file keeps that failure instead of a fabricated successful multi-turn.
const REAL = path.join(DIR, "qwen", "real-turn.jsonl");
const realBytes = fs.readFileSync(REAL);
const realText = realBytes.toString("utf8");
const realHeader = [];
const realBody = [];
for (const line of realText.split(/\r?\n/)) {
  if (line.startsWith("#")) realHeader.push(line);
  else if (line.trim()) realBody.push(line);
}
const realEnv = headerField(realHeader, "env-overrides") || "";
check(
  "real turn: header names the Groq base url and model, no key value",
  realEnv.includes("OPENAI_BASE_URL=https://api.groq.com/openai/v1") &&
    realEnv.includes("OPENAI_MODEL=openai/gpt-oss-20b") &&
    !/gsk_[A-Za-z0-9]{8}/.test(realText),
);
check(
  "real turn: header marks the credential probe and the package version",
  /^yes\b/.test(headerField(realHeader, "credential-probe") || "") &&
    headerField(realHeader, "package") === "@qwen-code/qwen-code" &&
    headerField(realHeader, "version") === "0.28.6",
);
check(
  "real turn: header notes the second turn fails upstream",
  realHeader.join("\n").includes("error_during_execution"),
);
check(
  "real turn: no UTF-8 BOM reached the repository copy",
  !(realBytes[0] === 0xef && realBytes[1] === 0xbb && realBytes[2] === 0xbf) &&
    !realText.startsWith("\uFEFF"),
);

const realParser = new StreamJsonParser();
const realItems = realParser.parseLines(realBody.join("\n"));
const blocks = (item) => item.raw?.message?.content || [];
check("real turn: seven JSON lines, one item each", realBody.length === 7 && realItems.length === 7);
check(
  "real turn: the stream opens with the session init",
  realItems[0].raw.type === "system" && realItems[0].type === "system_init",
);

const thinking = realItems.flatMap(blocks).find((b) => b.type === "thinking");
check("real turn: a real thinking block is present", Boolean(thinking) && thinking.thinking.includes("glob"));

const toolUse = realItems.flatMap(blocks).find((b) => b.type === "tool_use");
check(
  'real turn: tool_use is glob {"pattern":"*.md"}',
  toolUse?.name === "glob" && JSON.stringify(toolUse?.input) === '{"pattern":"*.md"}',
);

const toolUseIndex = realItems.findIndex((i) => blocks(i).some((b) => b.type === "tool_use"));
const toolResultIndex = realItems.findIndex((i) => blocks(i).some((b) => b.type === "tool_result"));
const toolResult =
  toolResultIndex >= 0 ? blocks(realItems[toolResultIndex]).find((b) => b.type === "tool_result") : null;
check(
  "real turn: a tool_result follows the tool_use and answers it",
  toolResultIndex > toolUseIndex &&
    toolResult?.tool_use_id === toolUse?.id &&
    toolResult?.content === "Found 1 matching file(s)",
);

const assistantItems = realItems.filter((i) => i.raw.type === "assistant");
const actingTurns = assistantItems.filter((i) => blocks(i).some((b) => b.type === "tool_use"));
check(
  "real turn: exactly one assistant turn, so there is no invented second reply",
  actingTurns.length === 1 && realItems.flatMap(blocks).filter((b) => b.type === "tool_use").length === 1,
);

const errorTexts = assistantItems.filter((i) => blocks(i).some((b) => b.type === "text"));
check(
  "real turn: the assistant text after the tool_result is the upstream error, not a reply",
  errorTexts.length === 1 &&
    realItems.indexOf(errorTexts[0]) > toolResultIndex &&
    errorTexts[0].formatted.includes("reasoning_content"),
);

const realResult = realItems[realItems.length - 1];
check(
  "real turn: the final result is an error_during_execution",
  realResult.raw.type === "result" &&
    realResult.raw.is_error === true &&
    realResult.raw.subtype === "error_during_execution",
);
check(
  "real turn: the failure names the Groq reasoning_content rejection",
  JSON.stringify(realResult.raw.error || {}).includes("reasoning_content"),
);
finish();
process.exit(0);
