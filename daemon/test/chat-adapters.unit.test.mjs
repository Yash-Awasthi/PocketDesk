// Chat adapters: each CLI's JSON stream (trimmed from real runs) must yield the
// reply text and a finished turn, and the next turn must resume that CLI's own
// session by id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, failureCount, failureNames, makeTmp } from "./helpers.mjs";

const tmp = makeTmp("rh-adapters-");
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const IS_WIN = process.platform === "win32";

const FIXTURES = {
  codex: [
    { type: "thread.started", thread_id: "cx-thread-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "command_execution", command: "cat a.txt", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "cat a.txt", aggregated_output: "x\n", exit_code: 0 } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "x" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } },
  ],
  opencode: [
    { type: "step_start", sessionID: "ses_oc1", part: { type: "step-start" } },
    { type: "tool_use", sessionID: "ses_oc1", part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a.txt" } } } },
    { type: "text", sessionID: "ses_oc1", part: { type: "text", text: "x" } },
    { type: "step_finish", sessionID: "ses_oc1", part: { type: "step-finish", reason: "stop", tokens: { input: 5, output: 1 }, cost: 0 } },
  ],
  gemini: [
    { type: "init", session_id: "gm-uuid-1", model: "auto" },
    { type: "message", role: "user", content: "read a.txt" },
    { type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { file_path: "a.txt" } },
    { type: "tool_result", tool_id: "t1", status: "success", output: "x" },
    { type: "message", role: "assistant", content: "x", delta: true },
    { type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 1 } },
  ],
  copilot: [
    { type: "user.message", data: { content: "read a.txt" } },
    { type: "assistant.message", data: { content: "", toolRequests: [{ name: "view" }] } },
    { type: "tool.execution_start", data: { toolName: "view", arguments: { path: "a.txt" } } },
    { type: "tool.execution_complete", data: { success: true, result: { content: "x\n" } } },
    { type: "assistant.message_delta", data: { deltaContent: "x" } },
    { type: "assistant.message", data: { content: "x", toolRequests: [] } },
    { type: "result", sessionId: "cp-uuid-1", exitCode: 0, usage: { premiumRequests: 1 } },
  ],
  cline: [
    { type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "read_files", input: { files: [{ path: "a.txt" }] } } },
    { type: "agent_event", event: { type: "content_end", contentType: "tool", toolName: "read_files", output: [{ result: "x" }] } },
    { type: "agent_event", event: { type: "content_start", contentType: "text", text: "x" } },
    { type: "agent_event", event: { type: "content_end", contentType: "text", text: "x" } },
    { type: "run_result", finishReason: "completed", usage: { inputTokens: 5, outputTokens: 1 } },
  ],
};

const calls = path.join(tmp, "calls.jsonl");
const agentJs = path.join(tmp, "fakeagent.js");
fs.writeFileSync(agentJs, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [kind, ...rest] = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind, argv: rest, stdin: input }) + "\\n");
  for (const ev of ${JSON.stringify(FIXTURES)}[kind]) process.stdout.write(JSON.stringify(ev) + "\\n");
});
`);

// Cline takes its prompt as an argument, which on Windows must reach node without cmd.exe.
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
if (IS_WIN) {
  fs.copyFileSync(agentJs, path.join(binDir, "fakeagent.js"));
  fs.writeFileSync(path.join(binDir, "fakecline.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\fakeagent.js" %*\r\n`);
} else {
  fs.copyFileSync(agentJs, path.join(binDir, "fakecline"));
  fs.chmodSync(path.join(binDir, "fakecline"), 0o755);
}
process.env.PATH = binDir + path.delimiter + process.env.PATH;

const chat = await import("../src/chat.js");

const manifests = {
  codex: { args: [agentJs, "codex", "exec"], resumeIdArgs: [agentJs, "codex", "resume", "{id}", "-"], format: "codex-json" },
  opencode: { args: [agentJs, "opencode", "run"], resumeIdArgs: [agentJs, "opencode", "run", "--session", "{id}"], format: "opencode-json" },
  gemini: { args: [agentJs, "gemini"], resumeIdArgs: [agentJs, "gemini", "--resume", "{id}"], format: "gemini-json" },
  copilot: { args: [agentJs, "copilot"], resumeIdArgs: [agentJs, "copilot", "--resume={id}"], format: "copilot-json" },
  cline: { bin: "fakecline", args: ["cline", "--json"], format: "cline-json", promptArg: true, inlineHistory: true },
};
// Cline has no headless resume, so its second prompt carries the first exchange instead.
const expectedId = { codex: "cx-thread-1", opencode: "ses_oc1", gemini: "gm-uuid-1", copilot: "cp-uuid-1", cline: "Assistant: x" };

function turn(c, text) {
  return new Promise((resolve) => {
    const ws = { readyState: 1, _subs: new Set(), send(raw) {
      const m = JSON.parse(raw);
      if (m.type === "chatstate" && m.state !== "running") { chat.detach(ws, c.id); resolve(m.state); }
    } };
    chat.attach(c.id, ws);
    chat.sendUserMessage(c, text);
  });
}
const lastCall = () => JSON.parse(fs.readFileSync(calls, "utf8").trim().split("\n").pop());

const workdir = path.join(tmp, "work");
fs.mkdirSync(workdir);
for (const [kind, m] of Object.entries(manifests)) {
  const { id } = chat.create({ manifest: { id: kind, bin: m.bin ?? "node", chat: m }, cwd: workdir });
  const c = chat.get(id);
  const state1 = await turn(c, "read a.txt; say it's \"done\" & 100% ok");
  const assistant = c.transcript.filter((t) => t.role === "assistant").map((t) => t.text).join("");
  check(`${kind}: turn ends idle`, state1 === "idle");
  check(`${kind}: reply text parsed`, assistant.trim() === "x");
  check(`${kind}: tool call surfaced`, c.transcript.some((t) => t.role === "tool"));
  const first = lastCall();
  const prompt = m.promptArg ? first.argv[first.argv.length - 1] : first.stdin.trim();
  check(`${kind}: prompt reaches the CLI verbatim`, prompt === "read a.txt; say it's \"done\" & 100% ok");
  const state2 = await turn(c, "again");
  check(`${kind}: second turn ends idle`, state2 === "idle");
  check(`${kind}: second turn resumes its own session`, lastCall().argv.join(" ").includes(expectedId[kind]));
}

// Any model name works where the CLI takes one by flag; the name reaches a cmd.exe command line, so it is charset-checked.
{
  const { id } = chat.create({ manifest: { id: "gm", bin: "node", chat: { ...manifests.gemini, modelArg: ["-m"] } }, cwd: workdir });
  const c = chat.get(id);
  check("custom model accepted", chat.setModel(id, "gemini-9-pro").ok);
  check("model name with shell characters refused", !chat.setModel(id, "x & calc").ok);
  check("listModels offers custom names", chat.listModels(id).custom === true);
  await turn(c, "hi");
  check("custom model reaches the CLI", lastCall().argv.join(" ").includes("-m gemini-9-pro"));
}

if (failureCount()) {
  console.error(`${failureCount()} FAILURE(S): ${failureNames()}`);
  process.exit(1);
}
console.log("ALL PASS");
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(0);
