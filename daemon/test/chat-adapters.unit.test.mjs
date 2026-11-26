// Chat adapters: each CLI's stream must yield the reply text and a finished turn,
// and the next turn must resume that CLI's own session by id. The streams are
// synthetic fixtures in test/fixtures/stream-adapters/, pinned to a target CLI version.
import fs from "node:fs";
import path from "node:path";
import { check, failureCount, failureNames, makeTmp } from "./helpers.mjs";
import { FIXTURE_VERSIONS, streamVersionStatus } from "../src/stream_versions.js";

const tmp = makeTmp("rh-adapters-");
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const IS_WIN = process.platform === "win32";

const FIXTURE_NAMES = ["claude", "codex", "opencode", "gemini", "copilot", "cline", "qwen"];
const loadFixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/stream-adapters/${name}.json`, import.meta.url), "utf8"));
const FIXTURE_FILES = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, loadFixture(name)]));
const FIXTURES = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, FIXTURE_FILES[name].events]));

const calls = path.join(tmp, "calls.jsonl");
const agentJs = path.join(tmp, "fakeagent.js");
fs.writeFileSync(
  agentJs,
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [kind, ...rest] = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind, argv: rest, stdin: input }) + "\\n");
  for (const ev of ${JSON.stringify(FIXTURES)}[kind]) process.stdout.write(typeof ev === "string" ? ev : JSON.stringify(ev) + "\\n");
});
`,
);

// Cline takes its prompt as an argument, which on Windows must reach node without cmd.exe.
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
if (IS_WIN) {
  fs.copyFileSync(agentJs, path.join(binDir, "fakeagent.js"));
  fs.writeFileSync(
    path.join(binDir, "fakecline.cmd"),
    `@ECHO off\r\n"%_prog%"  "%dp0%\\fakeagent.js" %*\r\n`,
  );
} else {
  fs.copyFileSync(agentJs, path.join(binDir, "fakecline"));
  fs.chmodSync(path.join(binDir, "fakecline"), 0o755);
}
process.env.PATH = binDir + path.delimiter + process.env.PATH;

const chat = await import("../src/chat.js");

const manifests = {
  claude: {
    args: [agentJs, "claude", "-p"],
    resumeIdArgs: [agentJs, "claude", "--resume", "{id}"],
    format: "claude-stream-json",
    models: { opus: { args: ["--model", "opus"] } },
  },
  codex: {
    args: [agentJs, "codex", "exec"],
    resumeIdArgs: [agentJs, "codex", "resume", "{id}", "-"],
    format: "codex-json",
  },
  opencode: {
    args: [agentJs, "opencode", "run"],
    resumeIdArgs: [agentJs, "opencode", "run", "--session", "{id}"],
    format: "opencode-json",
  },
  gemini: {
    args: [agentJs, "gemini"],
    resumeIdArgs: [agentJs, "gemini", "--resume", "{id}"],
    format: "gemini-json",
  },
  copilot: {
    args: [agentJs, "copilot"],
    resumeIdArgs: [agentJs, "copilot", "--resume={id}"],
    format: "copilot-json",
  },
  cline: {
    bin: "fakecline",
    args: ["cline", "--json"],
    format: "cline-json",
    promptArg: true,
    inlineHistory: true,
  },
};
// Cline has no headless resume, so its second prompt carries the first exchange instead.
const expectedId = {
  claude: "cl-1",
  codex: "cx-thread-1",
  opencode: "ses_oc1",
  gemini: "gm-uuid-1",
  copilot: "cp-uuid-1",
  cline: "Assistant: x",
};

const seen = [];
function turn(c, text, once) {
  return new Promise((resolve) => {
    const ws = {
      readyState: 1,
      _subs: new Set(),
      send(raw) {
        const m = JSON.parse(raw);
        seen.push(m);
        if (m.type === "chatstate" && m.state !== "running") {
          chat.detach(ws, c.id);
          resolve(m.state);
        }
      },
    };
    chat.attach(c.id, ws);
    chat.sendUserMessage(c, text, once);
  });
}
const lastCall = () => JSON.parse(fs.readFileSync(calls, "utf8").trim().split("\n").pop());

const workdir = path.join(tmp, "work");
fs.mkdirSync(workdir);
for (const [kind, m] of Object.entries(manifests)) {
  const { id } = chat.create({ manifest: { id: kind, bin: m.bin ?? "node", chat: m }, cwd: workdir });
  const c = chat.get(id);
  const state1 = await turn(c, 'read a.txt; say it\'s "done" & 100% ok');
  const assistant = c.transcript
    .filter((t) => t.role === "assistant")
    .map((t) => t.text)
    .join("");
  check(`${kind}: turn ends idle`, state1 === "idle");
  check(`${kind}: reply text parsed`, assistant.trim() === "x");
  check(
    `${kind}: tool call surfaced`,
    c.transcript.some((t) => t.role === "tool"),
  );
  const first = lastCall();
  const prompt = m.promptArg ? first.argv[first.argv.length - 1] : first.stdin.trim();
  check(`${kind}: prompt reaches the CLI verbatim`, prompt === 'read a.txt; say it\'s "done" & 100% ok');
  const state2 = await turn(c, "again");
  check(`${kind}: second turn ends idle`, state2 === "idle");
  check(`${kind}: second turn resumes its own session`, lastCall().argv.join(" ").includes(expectedId[kind]));
}

// Claude: a tool call shows when it starts and is filled in, not repeated, when its input arrives.
{
  const { id } = chat.create({
    manifest: { id: "claude", bin: "node", chat: manifests.claude },
    cwd: workdir,
  });
  const c = chat.get(id);
  seen.length = 0;
  await turn(c, "hi");
  const tools = c.transcript.filter((t) => t.role === "tool");
  check("claude: one tool item, completed in place", tools.length === 1 && tools[0].detail.includes("a.txt"));
  check(
    "claude: the tool reached the phone before its input was known",
    seen.some((m) => m.type === "chartool" && m.detail === "…"),
  );
  check(
    "claude: init commands reach the phone",
    seen.some((m) => m.type === "chat_info" && m.commands.includes("review")),
  );
  // A model and permission mode sent with one message apply to that turn only.
  await turn(c, "plan it", { model: "opus", permissionMode: "readonly" });
  const once = lastCall().argv.join(" ");
  check(
    "per-message model and mode reach the CLI",
    once.includes("--model opus") && once.includes("--permission-mode plan"),
  );
  await turn(c, "again");
  const after = lastCall().argv.join(" ");
  check(
    "the next message is back on the chat's settings",
    !after.includes("--model") && !after.includes("--permission-mode"),
  );
  check(
    "modelAllowed refuses an unlisted model where no name is free",
    !chat.modelAllowed(c, "gpt") && chat.modelAllowed(c, "opus") && chat.modelAllowed(c, null),
  );
}

// Any model name works where the CLI takes one by flag; the name reaches a cmd.exe command line, so it is charset-checked.
{
  const { id } = chat.create({
    manifest: { id: "gm", bin: "node", chat: { ...manifests.gemini, modelArg: ["-m"] } },
    cwd: workdir,
  });
  const c = chat.get(id);
  check("custom model accepted", chat.setModel(id, "gemini-9-pro").ok);
  check("model name with shell characters refused", !chat.setModel(id, "x & calc").ok);
  check("listModels offers custom names", chat.listModels(id).custom === true);
  await turn(c, "hi");
  check("custom model reaches the CLI", lastCall().argv.join(" ").includes("-m gemini-9-pro"));
}

// Qwen has no JSON stream: the text adapter passes its lines through unchanged.
{
  const { id } = chat.create({
    manifest: { id: "qwen", bin: "node", chat: { args: [agentJs, "qwen"], format: "text" } },
    cwd: workdir,
  });
  const c = chat.get(id);
  const state = await turn(c, "list files");
  const assistant = c.transcript
    .filter((t) => t.role === "assistant")
    .map((t) => t.text)
    .join("");
  check("qwen: turn ends idle", state === "idle");
  check("qwen: text passthrough parsed", assistant.trim() === "reading the manifest\ndone: 2 files checked");
  check("qwen: prompt reaches the CLI verbatim", lastCall().stdin.trim() === "list files");
}

// The fixture files and FIXTURE_VERSIONS are two sources of truth; they must agree.
for (const name of FIXTURE_NAMES) {
  const f = FIXTURE_FILES[name]._fixture;
  check(`${name}: fixture version matches FIXTURE_VERSIONS`, f.version === FIXTURE_VERSIONS[f.format]);
  check(
    `${name}: fixture is synthetic and says the CLI was absent`,
    f.produced === "synthetic" && f.note.includes("not installed"),
  );
}

const streamEntries = (c) => c.transcript.filter((t) => t.role === "system" && t.text.includes("[stream]"));
const chatWith = (kind, version) =>
  chat.get(
    chat.create({ manifest: { id: kind, bin: "node", chat: manifests[kind] }, cwd: workdir, version }).id,
  );

// Same version: quiet. Not detected: quiet.
{
  const ok = streamVersionStatus("codex-json", "0.55.0");
  check("same version is ok", ok.level === "ok" && ok.ok === true && ok.message === "");
  const same = chatWith("claude", FIXTURE_VERSIONS["claude-stream-json"]);
  check("same major emits no stream notice", streamEntries(same).length === 0);
  const none = streamVersionStatus("codex-json", null);
  check("not detected is quiet", none.level === "none" && none.ok === true && none.message === "");
  check("not detected chat stays quiet", streamEntries(chatWith("gemini", null)).length === 0);
  check("empty version chat stays quiet", streamEntries(chatWith("gemini", "")).length === 0);
}

// Minor drift warns by name, once, at chat start.
{
  const st = streamVersionStatus("codex-json", "0.56.0");
  check(
    "minor drift warns and names format and both versions",
    st.level === "warn" &&
      st.ok === false &&
      st.message.startsWith("[stream] ") &&
      st.message.includes("codex-json") &&
      st.message.includes("0.55.0") &&
      st.message.includes("0.56.0"),
  );
  const c = chatWith("codex", "0.56.0");
  const notices = streamEntries(c);
  check("minor drift warns in the transcript once", notices.length === 1 && notices[0].text === st.message);
}

// Major mismatch refuses; the chat still parses because the parser itself is unchanged.
{
  const st = streamVersionStatus("claude-stream-json", "3.0.0");
  check(
    "major mismatch refuses and names format and both versions",
    st.level === "refuse" &&
      st.ok === false &&
      st.message.includes("claude-stream-json") &&
      st.message.includes("2.0.14") &&
      st.message.includes("3.0.0") &&
      st.message.includes("not trusted"),
  );
  const c = chatWith("claude", "3.0.0");
  const notices = streamEntries(c);
  check("major mismatch lands in the transcript", notices.length === 1 && notices[0].text.includes("3.0.0"));
  const state = await turn(c, "hi");
  const assistant = c.transcript
    .filter((t) => t.role === "assistant")
    .map((t) => t.text)
    .join("");
  check("a refused version still parses the turn", state === "idle" && assistant.trim() === "x");
}

// An unparseable version cannot be compared: unknown, and visible.
{
  const st = streamVersionStatus("cline-json", "nightly");
  check(
    "unparseable version is unknown and names the raw string",
    st.level === "unknown" && st.ok === false && st.message.includes("nightly"),
  );
  check(
    "unknown version warns in the transcript once",
    streamEntries(chatWith("cline", "nightly")).length === 1,
  );
}

// One notice per chat start, not per message.
{
  const c = chatWith("copilot", "0.1.0");
  await turn(c, "hi");
  await turn(c, "again");
  check("the stream notice is emitted once, not per message", streamEntries(c).length === 1);
}

if (failureCount()) {
  console.error(`${failureCount()} FAILURE(S): ${failureNames()}`);
  process.exit(1);
}
console.log("ALL PASS");
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
process.exit(0);
