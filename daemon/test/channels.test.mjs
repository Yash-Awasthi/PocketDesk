/**
 * Push channel tests — ntfy + Pushover (salvaged from corpus
 * push_notification_bridge): capture the HTTP calls against a local server,
 * verify env auto-discovery in createNotificationManager.
 */
import assert from "node:assert";
import http from "node:http";
import { NtfyChannel } from "../src/channels/ntfy.js";
import { PushoverChannel } from "../src/channels/pushover.js";
import { createNotificationManager } from "../src/notifications.js";

let passed = 0;
function ok(name) { passed++; console.log(`  PASS  ${name}`); }

// Local capture server standing in for ntfy / Pushover.
const hits = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 1. ntfy: POST to /<topic>, title+priority headers, formatted body ──────
{
  const ch = new NtfyChannel({ topic: "rh-secret-topic", server: base });
  await ch.send("session_asking", { id: "s1", summary: "approve deploy?" });
  const h = hits.at(-1);
  assert.ok(h.url.startsWith(`/${encodeURIComponent("rh-secret-topic")}`), "posts to the topic path");
  assert.strictEqual(h.headers.title, "PocketDesk");
  assert.strictEqual(h.headers.priority, "high", "asking events are high priority");
  assert.ok(h.body.includes("approve deploy?"), "body carries the summary");
  await ch.send("chat_completed", { id: "c1" });
  assert.strictEqual(hits.at(-1).headers.priority, "default", "info events are default priority");
  ok("ntfy channel posts topic/body/priority");
}

// ── 2. Pushover: form-encoded token/user/message, priority mapping ─────────
{
  const ch = new PushoverChannel({ token: "appkey", user: "userkey", device: "pixel", apiBase: base });
  await ch.send("proposal_created", { id: "p1", summary: "run migration" });
  const h = hits.at(-1);
  const params = new URLSearchParams(h.body);
  assert.strictEqual(params.get("token"), "appkey");
  assert.strictEqual(params.get("user"), "userkey");
  assert.strictEqual(params.get("device"), "pixel");
  assert.strictEqual(params.get("priority"), "1", "proposals are elevated priority");
  assert.ok(params.get("message").includes("run migration"));
  await ch.send("chat_completed", { id: "c1" });
  assert.strictEqual(new URLSearchParams(hits.at(-1).body).get("priority"), "0");
  ok("pushover channel posts form-encoded payload with priorities");
}

// ── 3. Env auto-discovery in the manager ───────────────────────────────────
{
  const none = createNotificationManager({ config: {} });
  assert.ok(!none.channels().includes("ntfy") && !none.channels().includes("pushover"));
  const ntfyOnly = createNotificationManager({ config: { NTFY_TOPIC: "t" } });
  assert.ok(ntfyOnly.channels().includes("ntfy"), "NTFY_TOPIC enables ntfy");
  const both = createNotificationManager({ config: { NTFY_TOPIC: "t", PUSHOVER_TOKEN: "a", PUSHOVER_USER: "u" } });
  assert.deepStrictEqual(both.channels().filter((n) => n === "ntfy" || n === "pushover"), ["ntfy", "pushover"]);
  ok("manager env auto-discovery (NTFY_TOPIC, PUSHOVER_TOKEN+USER)");
}

server.close();
server.closeAllConnections?.();
// Give undici's keep-alive socket a beat to unwind — process.exit during
// socket teardown trips a libuv assertion on Windows (exit code 127).
await new Promise((r) => setTimeout(r, 100));
console.log(`\nALL PASS (${passed} tests)`);
process.exit(0);
