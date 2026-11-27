// Tool-call start/result correlation in the stream parser, driven directly
// against a parser instance (no daemon): out-of-order results, results spread
// over separate messages (assistant tool_use starts, user-carried tool_result
// blocks as Claude emits them), cancelled turns, and results that resolve
// nothing. Pairing must follow the tool id, never arrival order.
import { check, finish } from "./helpers.mjs";
import { StreamJsonParser } from "../src/stream_json_parser.js";

const p = new StreamJsonParser();

// Expected assistant-message count: only `type: "assistant"` lines with a
// `message` reach formatAssistantMessage, which is where the counter lives.
let assistantLines = 0;

function assistantLine(content) {
  assistantLines++;
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", id: "m" + assistantLines, content },
  });
}

// The shape Claude actually emits: a tool_result arrives inside a user message.
function userLine(content) {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

function toolUse(id, name = "bash", input = {}) {
  return { type: "tool_use", tool_use: { id, name, input } };
}

function toolResult(id, content, isError = false) {
  return { type: "tool_result", tool_result: { toolUseId: id, content, isError } };
}

let linesParsed = 0;

function parse(line, label) {
  const item = p.parseLine(line);
  linesParsed++;
  check(`${label}: parseLine returns a formatted item (not null)`, item !== null);
  return item;
}

const pendingIds = () =>
  p
    .getPendingTools()
    .map((t) => t.id)
    .join(",");

// Non-assistant traffic: must format without counting as an assistant message.
parse(JSON.stringify({ type: "system", subtype: "init", model: "claude-3", cwd: "/w" }), "system init");
const userText = parse(
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "run the tests" }] } }),
  "user text",
);
check("text-only user line still formats as [USER] <text>", userText.formatted === "[USER] run the tests");
check("system/user lines leave messageCount at 0", p.getStats().messageCount === 0);

// ---- 1. two tools started, results arrive in reverse order ----------------
const started = parse(
  assistantLine([toolUse("t1", "bash", { command: "ls" }), toolUse("t2", "read", { path: "b" })]),
  "start t1+t2",
);
check("both tools pending after start", p.getStats().pendingTools === 2);
check(
  "TOOL lines name t1's and t2's tool",
  started.formatted.includes("[TOOL: bash]") && started.formatted.includes("[TOOL: read]"),
);

const resT2 = parse(assistantLine([toolResult("t2", "output-of-t2")]), "result for t2 first");
check("pendingTools 2 -> 1 after t2 result", p.getStats().pendingTools === 1);
check("remaining pending tool is t1", pendingIds() === "t1");
check(
  "RESULT line names t2 with t2's payload",
  resT2.formatted.includes("[RESULT: t2]") && resT2.formatted.includes("output-of-t2"),
);

const resT1 = parse(assistantLine([toolResult("t1", "output-of-t1")]), "result for t1 second");
check("pendingTools 1 -> 0 after t1 result", p.getStats().pendingTools === 0);
check(
  "RESULT line names t1 with t1's payload",
  resT1.formatted.includes("[RESULT: t1]") && resT1.formatted.includes("output-of-t1"),
);
check(
  "results pair by id, not arrival order",
  resT2.formatted.includes("t2") && !resT2.formatted.includes("t1") && resT1.formatted.includes("t1"),
);

// ---- 2. interleaved across separate assistant messages, user-shaped results --
parse(assistantLine([toolUse("t4", "grep", { pattern: "a" })]), "message A starts t4");
parse(assistantLine([toolUse("t5", "grep", { pattern: "b" })]), "message B starts t5");
check("two separate starts leave both pending", p.getStats().pendingTools === 2);
check("pending ids are t4,t5", pendingIds() === "t4,t5");

const iResT5 = parse(userLine([toolResult("t5", "found-b")]), "user message resolves t5");
check("pendingTools 2 -> 1 across messages", p.getStats().pendingTools === 1);
check("remaining pending id is t4", pendingIds() === "t4");
const iResT4 = parse(userLine([toolResult("t4", "found-a")]), "user message resolves t4");
check("pendingTools 1 -> 0 across messages", p.getStats().pendingTools === 0);
check(
  "interleaved RESULT lines name t5 then t4",
  iResT5.formatted.includes("[RESULT: t5]") && iResT4.formatted.includes("[RESULT: t4]"),
);
check(
  "interleaved payloads stay with their ids",
  iResT5.formatted.includes("found-b") && iResT4.formatted.includes("found-a"),
);

// ---- 3. cancelled turn, real wire shape (user message, isError) -------------
parse(assistantLine([toolUse("t3", "bash", { command: "sleep 60" })]), "start t3");
check("t3 pending before cancellation", p.getStats().pendingTools === 1);
const cancelItem = parse(
  userLine([{ type: "text", text: "stopping" }, toolResult("t3", "cancelled by user", true)]),
  "cancelled tool_result in a user message",
);
check("cancelled result clears the pending tool", p.getStats().pendingTools === 0);
check(
  "cancelled RESULT is marked ERROR and names t3",
  cancelItem.formatted.includes("ERROR") && cancelItem.formatted.includes("t3"),
);
check(
  "user text next to a result still lands after [USER]",
  cancelItem.formatted.startsWith("[USER] stopping"),
);

// ---- 4. cancelled tool_result with no content at all (user message) --------
parse(assistantLine([toolUse("t6", "bash", { command: "sleep 90" })]), "start t6");
check("t6 pending before contentless cancellation", p.getStats().pendingTools === 1);
const noContentItem = parse(
  userLine([{ type: "tool_result", tool_result: { toolUseId: "t6", isError: true } }]),
  "contentless cancelled tool_result in a user message",
);
check("contentless result still returns an item", noContentItem !== null);
check("contentless result clears pending back to 0", p.getStats().pendingTools === 0);
check("contentless RESULT names t6", noContentItem.formatted.includes("[RESULT: t6]"));

// ---- 5. duplicate and unknown results ------------------------------------
const duplicate = parse(
  assistantLine([toolResult("t6", "late duplicate")]),
  "duplicate result for resolved t6",
);
check("duplicate result leaves pending at 0", p.getStats().pendingTools === 0);
check("duplicate result still formats normally", duplicate.formatted.includes("[RESULT: t6]"));
const unknown = parse(assistantLine([toolResult("tX", "no such tool")]), "result for unknown id tX");
check("unknown result leaves pending at 0", p.getStats().pendingTools === 0);
check("unknown result still formats normally", unknown.formatted.includes("[RESULT: tX]"));

// ---- 6. final stats ------------------------------------------------------
const stats = p.getStats();
check("stats.pendingTools is 0", stats.pendingTools === 0);
check("stats.messageCount counts only assistant messages", stats.messageCount === assistantLines);
check("messageCount ignores system/user lines", stats.messageCount < linesParsed);

finish();
process.exit(0);
