// Resuming a saved Claude Code conversation: the seeded transcript must survive the
// next turn untouched, and the new reply must land once -- in the chat, on the wire
// and in the saved history file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, failureCount, failureNames, finish, makeTmp } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = makeTmp("rh-resume-");
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir, { recursive: true });

// Every root the daemon reads from points into the tmp dir, set before the imports below.
process.env.AH_HOME = tmp;
process.env.AH_USERDATA = path.join(tmp, "userdata");
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.POCKETDESK_DATA = dataDir;
process.env.RH_HOME = path.join(tmp, ".pocketdesk");

// A captured Claude Code session, copied where claudeList looks for it.
const proj = path.join(tmp, ".claude", "projects", "P");
fs.mkdirSync(proj, { recursive: true });
fs.copyFileSync(path.join(here, "fixtures", "claude-session.jsonl"), path.join(proj, "s.jsonl"));

const REPLY = "The file still says: hello from a.txt";
const argvLog = path.join(tmp, "argv.jsonl");
const agentJs = path.join(tmp, "fakeagent.cjs");
fs.writeFileSync(agentJs, `"use strict";
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  const reply = ${JSON.stringify(REPLY)};
  process.stdout.write(JSON.stringify({ type: "assistant", session_id: "s", message: { role: "assistant", content: [{ type: "text", text: reply }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", result: reply, usage: { input_tokens: 9, output_tokens: 12 } }) + "\\n");
});
`);

const agentHistory = await import("../src/agent_history.js");
const chat = await import("../src/chat.js");

const count = (arr, pred) => arr.filter(pred).length;
const itemKey = (m) => [m.role, m.name ?? "", m.text ?? m.detail ?? ""].join("\u0000");
const tally = (items) => {
  const m = new Map();
  for (const it of items) m.set(itemKey(it), (m.get(itemKey(it)) ?? 0) + 1);
  return m;
};
const consecutiveAssistantDupes = (items) =>
  items.some((it, i) => i > 0 && it.role === "assistant" && items[i - 1].role === "assistant" && it.text === items[i - 1].text);

/** One user message through a live attach, until the chat leaves "running". */
function turn(c, text, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { chat.detach(ws, c.id); resolve("timeout"); }, timeoutMs);
    ws = { readyState: 1, _subs: new Set(), send(raw) {
      const m = JSON.parse(raw);
      if (m.type === "chatstate" && m.state !== "running") {
        clearTimeout(timer);
        chat.detach(ws, c.id);
        resolve(m.state);
      }
    } };
    chat.attach(c.id, ws);
    chat.sendUserMessage(c, text);
  });
}

try {
  // 1. The saved conversation reads back as one user prompt, one assistant text, one tool, one final text.
  const h = await agentHistory.get("claude", "s");
  check("history: the captured session is found", Boolean(h) && h.resumable === true);
  const items = h?.items ?? [];
  check("history: the ai-title line names it, not a transcript item", h?.title === "Reading a.txt");
  check("history: roles are user, assistant, tool, assistant", items.map((i) => i.role).join(",") === "user,assistant,tool,assistant");
  check("history: the user prompt appears exactly once", count(items, (i) => i.role === "user" && i.text === "Read a.txt and tell me what it says.") === 1);
  check("history: the tool result line is not a user message", !items.some((i) => typeof i.text === "string" && i.text.includes("hello from a.txt") && i.role === "user"));
  check("history: the Read call appears exactly once", count(items, (i) => i.role === "tool" && i.name === "Read") === 1);
  check("history: each assistant text appears exactly once", count(items, (i) => i.role === "assistant") === 2 && items[1].text === "I'll read the file first.");

  // 2. Seed a chat the way history_resume does.
  const transcript = items.map((it) => (it.role === "tool" ? { role: "tool", name: it.name, detail: it.detail } : { role: it.role, text: it.text }));
  const { id } = chat.create({
    manifest: { id: "claude", bin: "node", chat: { args: [agentJs], resumeIdArgs: [agentJs, "--resume", "{id}"], format: "claude-stream-json" } },
    cwd: tmp,
    resumeFirst: true,
    cliSession: "s",
    transcript,
  });
  const c = chat.get(id);
  const seeded = JSON.parse(JSON.stringify(c.transcript));
  const seededTally = tally(seeded);
  check("seed: the chat starts with the saved turns", seeded.length === 4);

  // 3. One new message, resuming by session id.
  const state = await turn(c, "And now?");
  check("resume: the turn ends idle", state === "idle");
  check("resume: the CLI was called with --resume s", fs.readFileSync(argvLog, "utf8").trim().split("\n").some((l) => JSON.parse(l).join(" ").includes("--resume s")));

  // 4. The saved turns are byte-identical; the reply is one new message.
  const prefix = JSON.parse(JSON.stringify(c.transcript.slice(0, seeded.length)));
  check("resume: the seeded transcript is unchanged by the new turn", JSON.stringify(prefix) === JSON.stringify(seeded));
  check("resume: the new user message is appended", c.transcript.at(-2)?.role === "user" && c.transcript.at(-2)?.text === "And now?");
  check("resume: the new reply appears exactly once", count(c.transcript, (i) => i.role === "assistant" && i.text === REPLY) === 1);
  check("resume: the new reply is its own message", c.transcript.at(-1)?.role === "assistant" && c.transcript.at(-1)?.text === REPLY);
  check("resume: no consecutive duplicate assistant messages", !consecutiveAssistantDupes(c.transcript));

  // 5. The saved history file holds every message exactly once.
  const files = fs.readdirSync(path.join(dataDir, "chat-history")).filter((f) => f.endsWith(".json"));
  check("saved history: one file for the chat", files.length === 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "chat-history", files[0]), "utf8")).transcript;
  const savedTally = tally(saved);
  check("saved history: every seeded message appears exactly once", [...seededTally].every(([k, n]) => savedTally.get(k) === n && n === 1));
  check("saved history: the new reply appears exactly once", count(saved, (i) => i.role === "assistant" && i.text === REPLY) === 1);
  check("saved history: no message is stored twice", [...savedTally.values()].every((n) => n === 1));
  check("saved history: no consecutive duplicate assistant messages", !consecutiveAssistantDupes(saved));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (failureCount()) {
  console.error(`${failureCount()} FAILURE(S): ${failureNames()}`);
  process.exit(1);
}
finish();
process.exit(0);
