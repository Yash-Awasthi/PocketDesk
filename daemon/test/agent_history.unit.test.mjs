// Saved agent conversations read from each agent's own store, built here as fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { check, finish } from "./helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-history-"));
const at = (...p) => path.join(tmp, ...p);
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
process.env.AH_HOME = at("home");
process.env.AH_USERDATA = at("userdata");
const { list, get, replayChatLog } = await import("../src/agent_history.js");

try {
  write(at("home", ".claude", "projects", "C--proj", "s1.jsonl"), jsonl(
    { type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" }, cwd: "C:\\proj", entrypoint: "claude-vscode" },
    { type: "user", message: { content: "fix the build" }, cwd: "C:\\proj", entrypoint: "claude-vscode" },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    { type: "ai-title", aiTitle: "Build fix" },
  ));
  write(at("home", ".claude", "projects", "C--proj", "empty.jsonl"), jsonl({ type: "mode", mode: "normal" }));
  write(at("home", ".codex", "sessions", "2026", "10", "21", "rollout-a.jsonl"), jsonl(
    { type: "session_meta", payload: { id: "cx1", cwd: "/w", originator: "codex_cli_rs" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add tests" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added." }] } },
  ));
  const ws = at("userdata", "Code", "User", "workspaceStorage", "abc");
  write(path.join(ws, "workspace.json"), JSON.stringify({ folder: "file:///c%3A/repo" }));
  write(path.join(ws, "chatSessions", "cp1.jsonl"), jsonl(
    { kind: 0, v: { sessionId: "cp1", requests: [] } },
    { kind: 2, k: ["requests"], v: [{ message: { text: "explain this" }, response: [] }] },
    { kind: 2, k: ["requests", 0, "response"], v: [{ value: "It " }, { value: { value: "works." } }] },
  ));
  write(at("userdata", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks", "t1", "ui_messages.json"), JSON.stringify([
    { type: "say", say: "task", text: "refactor auth" }, { type: "say", say: "text", text: "Refactored." }, { type: "ask", ask: "tool", text: "{}" },
  ]));
  fs.mkdirSync(at("userdata", "Cursor", "User", "globalStorage"), { recursive: true });
  const cur = new DatabaseSync(at("userdata", "Cursor", "User", "globalStorage", "state.vscdb"));
  cur.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const put = cur.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  put.run("composerData:k1", JSON.stringify({ composerId: "k1", name: "Cursor task", lastUpdatedAt: 5, fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }] }));
  put.run("bubbleId:k1:b1", JSON.stringify({ type: 1, text: "hello cursor" }));
  put.run("bubbleId:k1:b2", JSON.stringify({ type: 2, text: "hi" }));
  cur.close();
  fs.mkdirSync(at("home", ".gemini", "antigravity"), { recursive: true });
  const agy = new DatabaseSync(at("home", ".gemini", "antigravity", "conversation_summaries.db"));
  agy.exec("CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, last_modified_time datetime)");
  agy.exec("CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, user_body, agent_body)");
  agy.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run("g1", "Gesture work", "", JSON.stringify(["file:///c%3A/app"]), "2026-10-19 03:26:24.6884587+00:00");
  agy.prepare("INSERT INTO conversations_fts VALUES (?, ?, ?, ?)").run("g1", 0, "make it faster", "Made it faster.");
  agy.close();

  const items = await list();
  const by = (agent) => items.find((i) => i.agent === agent);
  check("claude: titled session found, empty one skipped", by("claude")?.title === "Build fix" && items.filter((i) => i.agent === "claude").length === 1);
  check("claude: VS Code extension sessions are told apart from the CLI", by("claude")?.app === "VS Code" && by("claude")?.resumable);
  check("codex: injected context is not the title", by("codex")?.title === "add tests" && by("codex")?.app === "CLI");
  check("copilot: the mutation log replays to its first prompt", by("copilot")?.title === "explain this" && by("copilot")?.app === "VS Code");
  check("copilot: workspace folder becomes the cwd", /repo$/.test(by("copilot")?.cwd ?? ""));
  check("cline: task text is the title", by("cline")?.title === "refactor auth");
  check("cursor: composer name is the title", by("cursor")?.title === "Cursor task");
  check("antigravity: summary row is listed with its workspace", by("antigravity")?.title === "Gesture work" && /app$/.test(by("antigravity").cwd));
  check("no file path reaches the phone", items.every((i) => !("ref" in i)));

  const c = await get("claude", "s1");
  check("claude transcript: meta prompts dropped, tool calls kept", c.items.map((i) => i.role).join() === "user,assistant,tool" && c.items[2].name === "Bash");
  check("codex transcript", (await get("codex", "cx1")).items.map((i) => i.text).join("|") === "add tests|Added.");
  check("copilot transcript joins response parts", (await get("copilot", "cp1")).items.at(-1)?.text === "It works.");
  check("cline transcript keeps only said text", (await get("cline", "t1")).items.length === 2);
  check("cursor transcript reads its bubbles", (await get("cursor", "k1")).items.map((i) => i.role).join() === "user,assistant");
  check("antigravity transcript", (await get("antigravity", "g1")).items.at(-1)?.text === "Made it faster.");
  check("an unknown conversation is null", (await get("claude", "nope")) === null);

  const s = replayChatLog(jsonl({ kind: 0, v: { a: [1, 2, 3] } }, { kind: 2, k: ["a"], v: [9], i: 1 }, { kind: 1, k: ["b"], v: "x" }, { kind: 3, k: ["b"] }));
  check("chat log: an append at an index replaces the tail; set and delete apply", JSON.stringify(s) === '{"a":[1,9]}');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
