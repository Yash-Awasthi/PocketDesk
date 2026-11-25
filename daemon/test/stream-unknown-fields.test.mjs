// Unknown-field tolerance for the agent stream-json parser.
// Real Claude stream events grow new keys over releases. The parser must carry
// those keys through untouched in `raw` without changing typed output, stats or
// pending-tool tracking. Purely in-memory: no daemon, no sockets.
import { check, finish } from "./helpers.mjs";
import { StreamJsonParser } from "../src/stream_json_parser.js";

const EXPECTED_TYPES = [
  "system_init",
  "user_message",
  "assistant_tool_use",
  "user_message",
  "metadata",
  "assistant_text",
  "unknown",
];

// Baseline transcript: the shapes the daemon already handles, in the order the
// task calls for (init, user, assistant text + tool_use, user tool_result,
// metadata, plain assistant text, one unrecognised event type).
function baselineEvents() {
  return [
    { type: "system", subtype: "init", model: "claude-3", cwd: "/work", tools: ["bash", "read"], mcp_servers: ["filesystem"] },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "summarize the repo" }] } },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", tool_use: { id: "t1", name: "bash", input: { command: "ls" } } },
    ], usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "go on" }] } },
    { type: "metadata", subtype: "usage", session_id: "sess-1" },
    { type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "telemetry_ping", provider: "anthropic", payload: { seq: 7 } },
  ];
}

// Same event plus unknown keys at every level a future agent version might add
// them. Tags are unique per event so a stray field cannot satisfy a check.
function augment(event, tag) {
  const e = JSON.parse(JSON.stringify(event));
  e.x_unknown_top = "top-" + tag;
  e.x_future_envelope = { version: 2, hints: [tag, "extra"] };
  if (e.message) {
    e.message.x_unknown_message = "message-" + tag;
    for (const block of e.message.content || []) {
      block.x_unknown_block = "block-" + tag;
      if (block.tool_use) block.tool_use.x_unknown_tool_field = "tool-" + tag;
      if (block.tool_result) block.tool_result.x_unknown_result_field = "result-" + tag;
    }
    if (e.message.usage) {
      e.message.usage.x_unknown_usage_field = "usage-" + tag;
      e.message.usage.server_tool_use_extra = { web_search_requests: 0 };
    }
  }
  return e;
}

function toLines(events) {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function main() {
  const baseEvents = baselineEvents();
  const augEvents = baseEvents.map((e, i) => augment(e, "e" + i));
  const baseLines = toLines(baseEvents);

  // The malformed line sits mid-stream: a later event must still parse.
  const malformed = '{"type": "assistant", "message": { broken';
  const augLines = [...augEvents.slice(0, 5).map((e) => JSON.stringify(e)), malformed, ...augEvents.slice(5).map((e) => JSON.stringify(e))].join("\n");

  const bp = new StreamJsonParser();
  const ap = new StreamJsonParser();
  const base = bp.parseLines(baseLines);
  const aug = ap.parseLines(augLines);

  // --- shape parity -------------------------------------------------------
  check("augmented transcript yields the same item count", aug.length === base.length && aug.length === 7);
  check("golden type sequence", JSON.stringify(base.map((i) => i.type)) === JSON.stringify(EXPECTED_TYPES));
  check("augmented type sequence is unchanged", JSON.stringify(aug.map((i) => i.type)) === JSON.stringify(EXPECTED_TYPES));
  check("every item has a string formatted field", aug.every((i) => typeof i.formatted === "string"));

  const typedFormattedMatch = base.every((b, i) => b.type === "unknown" || b.formatted === aug[i].formatted);
  check("formatted strings identical for every typed event", typedFormattedMatch);

  // The unknown event's formatted text is its own JSON, so it necessarily
  // includes the extra keys; assert the documented behaviour instead.
  const bUnknown = base[base.length - 1];
  const aUnknown = aug[aug.length - 1];
  check("unknown event type is unknown in both transcripts", bUnknown.type === "unknown" && aUnknown.type === "unknown");
  check("unknown event formatted is the raw event JSON", aUnknown.formatted === JSON.stringify(aUnknown.raw));

  check("system_init formatted is unchanged", aug[0].formatted === "[SYSTEM] Session started | model: claude-3 | cwd: /work | tools: bash, read | mcp: filesystem");
  check("tool_use formatted is unchanged", aug[2].formatted === 'Let me check.\n[TOOL: bash] {"command":"ls"}');

  // --- raw preservation ---------------------------------------------------
  let topOk = true;
  aug.forEach((item, i) => {
    const raw = item.raw;
    if (!raw || raw.x_unknown_top !== "top-e" + i) topOk = false;
    if (!raw.x_future_envelope || raw.x_future_envelope.version !== 2 || raw.x_future_envelope.hints[0] !== "e" + i) topOk = false;
  });
  check("every parsed raw keeps the top-level unknown fields", topOk);

  check("message-level unknown field survives", aug[1].raw.message.x_unknown_message === "message-e1");
  check("usage nested unknown fields survive", aug[2].raw.message.usage.x_unknown_usage_field === "usage-e2"
    && aug[2].raw.message.usage.server_tool_use_extra.web_search_requests === 0);
  check("known usage counters survive injection", aug[2].raw.message.usage.input_tokens === 100 && aug[2].raw.message.usage.output_tokens === 20);
  check("content-block unknown field survives", aug[2].raw.message.content[0].x_unknown_block === "block-e2"
    && aug[2].raw.message.content[1].x_unknown_block === "block-e2");
  check("tool_use nested unknown field survives", aug[2].raw.message.content[1].tool_use.x_unknown_tool_field === "tool-e2"
    && aug[2].raw.message.content[1].tool_use.id === "t1");
  check("user text block unknown field survives", aug[3].raw.message.content[0].x_unknown_block === "block-e3"
    && aug[3].raw.message.content[0].text === "go on");
  check("raw content block count untouched", aug[2].raw.message.content.length === 2 && aug[3].raw.message.content.length === 1);

  // --- stats parity -------------------------------------------------------
  const bs = bp.getStats();
  const as = ap.getStats();
  check("stats identical between transcripts", JSON.stringify(as) === JSON.stringify(bs));
  check("stats keep their expected values", bs.messageCount === 2
    && bs.totalInputTokens === 100
    && bs.totalOutputTokens === 20
    && bs.pendingTools === 1);
  check("pending tool still tracked", ap.getPendingTools().length === 1 && ap.getPendingTools()[0].id === "t1");

  // Unknown event on its own: no throw, no stats movement.
  const up = new StreamJsonParser();
  const unknownItems = up.parseLines(JSON.stringify(augEvents[6]));
  const us = up.getStats();
  check("unknown event parses alone without throwing", unknownItems.length === 1 && unknownItems[0].type === "unknown");
  check("unknown event alone leaves stats at zero", us.messageCount === 0
    && us.totalInputTokens === 0
    && us.totalOutputTokens === 0
    && us.pendingTools === 0);

  // Unknown event appended to an already-parsed stream: stats unchanged.
  const up2 = new StreamJsonParser();
  up2.parseLines(baseLines);
  const before = JSON.stringify(up2.getStats());
  const beforePending = JSON.stringify(up2.getPendingTools());
  up2.parseLines(JSON.stringify(augEvents[6]));
  check("unknown event appended does not change stats", JSON.stringify(up2.getStats()) === before);
  check("unknown event appended does not change pending tools", JSON.stringify(up2.getPendingTools()) === beforePending);

  // --- malformed line -----------------------------------------------------
  check("malformed line is skipped without breaking the rest", aug.length === base.length && aug[5].type === "assistant_text" && aug[5].formatted === "Done.");
  check("malformed line alone yields no items", new StreamJsonParser().parseLines(malformed).length === 0);
  check("malformed line does not throw", (() => {
    try { new StreamJsonParser().parseLines(malformed + "\n" + baseLines); return true; } catch { return false; }
  })());
}

try {
  main();
} catch (err) {
  check("no unexpected exception: " + (err && err.message), false);
}

finish();
process.exit(0);
