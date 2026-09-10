// Stream JSON parser absorption test — exercises the stream_* protocol surface
// (format-claude-stream inspiration): feed raw agent JSONL over the wire, get
// back typed/structured messages, token stats, pending-tool tracking, reset.
// Fully in-memory — deterministic, no external processes.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8808;
const TOKEN = "testtoken";
const CLI_PORT = 46808;

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // System init + user + assistant with tool use in one batch.
  const jsonl = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-3", cwd: "/work", tools: ["bash", "read"], mcp_servers: ["filesystem"] }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "summarize the repo" }] } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", tool_use: { id: "t1", name: "bash", input: { command: "ls" } } },
    ], usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [
      { type: "tool_result", tool_result: { toolUseId: "t1", content: "src/\n", isError: false } },
    ] } }),
    "not json at all",
  ].join("\n");

  c.send({ type: "stream_parse", lines: jsonl });
  const parsed = await c.next((m) => m.type === "stream_parsed");
  check("stream_parse returns 4 typed messages", parsed.items.length === 4);
  check("system_init formatted", parsed.items[0].type === "system_init" && parsed.items[0].formatted.includes("model: claude-3"));
  check("user_message formatted", parsed.items[1].type === "user_message" && parsed.items[1].formatted.includes("summarize the repo"));
  check("tool_use typed + formatted", parsed.items[2].type === "assistant_tool_use" && parsed.items[2].formatted.includes("[TOOL: bash]"));
  check("tool_result formatted", parsed.items[3].type === "assistant_text" && parsed.items[3].formatted.includes("[RESULT: t1]"));
  check("token stats accumulate", parsed.stats.messageCount === 2 && parsed.stats.totalInputTokens === 100 && parsed.stats.totalOutputTokens === 20);

  // Pending tool tracking: t1 still pending before its result resolved it.
  check("pendingTools reflects resolved tool", parsed.stats.pendingTools === 0);

  c.send({ type: "stream_stats" });
  const stats = await c.next((m) => m.type === "stream_stats");
  check("stream_stats matches", stats.messageCount === 2 && stats.pendingTools === 0);

  // A dangling tool_use leaves a pending tool.
  c.send({ type: "stream_parse", lines: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", tool_use: { id: "t2", name: "read", input: { path: "a" } } }] } }) });
  const parsed2 = await c.next((m) => m.type === "stream_parsed");
  check("dangling tool_use stays pending", parsed2.stats.pendingTools === 1);

  c.send({ type: "stream_reset" });
  const reset = await c.next((m) => m.type === "stream_reset");
  check("stream_reset clears state", reset.ok === true);
  c.send({ type: "stream_stats" });
  const zeroed = await c.next((m) => m.type === "stream_stats");
  check("stats zeroed after reset", zeroed.messageCount === 0 && zeroed.pendingTools === 0);

  // Garbage input → no crash, empty result.
  c.send({ type: "stream_parse", lines: "%%%%\n" });
  const garbage = await c.next((m) => m.type === "stream_parsed");
  check("garbage lines are skipped safely", garbage.items.length === 0);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });