/**
 * Plugin system tests.
 * Run with: node test/plugins.test.mjs
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginManager, createTestHarness } from "../src/plugins.js";
import chatTag from "../examples/plugins/chat-tag/plugin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "..", "src", "plugins");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

function mockCtx() {
  return {
    sessions: { summary: () => [] },
    chat: { summary: () => [] },
    registry: { list: () => [] },
    broadcast: () => {},
    config: { port: 8765, token: "test-token" },
  };
}

console.log("plugins");

await test("loads plugins from plugins directory", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  const loaded = pm.list();
  assert.ok(loaded.length >= 3, `expected >=3 plugins, got ${loaded.length}`);
  const names = loaded.map((p) => p.name);
  assert.ok(names.includes("logger"), "logger missing");
  assert.ok(names.includes("metrics"), "metrics missing");
  assert.ok(names.includes("auth"), "auth missing");
});

await test("handles missing directory gracefully", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover("/nonexistent/path");
  assert.equal(pm.list().length, 0);
});

await test("fires onConnect hook without error", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  const ws = { _subs: new Set(), _authed: false, readyState: 1 };
  await pm.callHook("onConnect", ws);
});

await test("fires onMessage hook for each message", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  const ws = { _subs: new Set(), _authed: true, readyState: 1 };
  const msg = { type: "chatmsg", id: "c1", text: "hello" };
  const { blocked } = await pm.callHook("onMessage", ws, msg);
  assert.equal(blocked, false);
});

await test("blocks unauthenticated messages via auth plugin", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  const ws = { _subs: new Set(), _authed: false, readyState: 1 };
  const msg = { type: "chatmsg", text: "hello" };
  const { blocked } = await pm.callHook("onMessage", ws, msg);
  assert.equal(blocked, true);
});

await test("passes through authenticated messages", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  const ws = { _subs: new Set(), _authed: true, readyState: 1 };
  const msg = { type: "fs", path: "/tmp" };
  const { blocked } = await pm.callHook("onMessage", ws, msg);
  assert.equal(blocked, false);
});

await test("plugin hooks keep their `this` binding", async () => {
  // logger plugin holds state on `this` (this._stream / this._log) — a
  // detached hook call must not throw "Cannot read properties of undefined".
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  await pm.startAll();
  await pm.stopAll();
});

await test("list returns plugin metadata", async () => {
  const pm = createPluginManager(mockCtx());
  await pm.discover(PLUGIN_DIR);
  for (const p of pm.list()) {
    assert.ok(p.name, "name missing");
    assert.ok(p.version, "version missing");
    assert.ok(Array.isArray(p.hooks), "hooks not an array");
  }
});

await test("harness builds a manager around a mock ctx and drives hooks", async () => {
  let seenCtx = null;
  const h = createTestHarness({
    name: "probe",
    version: "1.0.0",
    hooks: ["init"],
    init(ctx) {
      seenCtx = ctx;
    },
  });

  assert.equal(h.ctx.config.port, 8765);
  assert.ok(h.ctx.config.token, "token missing");
  assert.ok(h.ctx.config.dataDir, "dataDir missing");
  assert.ok(h.ctx.sessions && h.ctx.chat && h.ctx.registry && h.ctx.proposals);
  assert.equal(typeof h.ctx.broadcast, "function");
  assert.deepEqual(
    h.list().map((p) => p.name),
    ["probe"],
  );

  await h.init();
  assert.equal(seenCtx, h.ctx);
  assert.deepEqual(
    h.events.map((e) => e.hook),
    ["init"],
  );

  const { blocked } = await h.call("onMessage", {}, { type: "chatmsg", text: "x" });
  assert.equal(blocked, false);
  assert.equal(h.events.at(-1).hook, "onMessage");
});

await test("lifecycle runs init -> start -> stop and events fire after init", async () => {
  const calls = [];
  const h = createTestHarness({
    name: "lifecycle",
    version: "1.0.0",
    hooks: ["init", "start", "stop", "onMessage"],
    init() {
      calls.push("init");
    },
    start() {
      calls.push("start");
    },
    stop() {
      calls.push("stop");
    },
    onMessage() {
      calls.push("onMessage");
    },
  });

  await h.init();
  await h.start();
  await h.call("onMessage", {}, { type: "chatmsg", text: "x" });
  await h.stop();

  assert.deepEqual(calls, ["init", "start", "onMessage", "stop"]);
  assert.deepEqual(
    h.events.map((e) => e.hook),
    ["init", "start", "onMessage", "stop"],
  );
  assert.ok(
    h.events.findIndex((e) => e.hook === "init") < h.events.findIndex((e) => e.hook === "onMessage"),
    "onMessage ran before init",
  );
});

await test("{ block: true } stops delivery to later plugins", async () => {
  const reached = [];
  const h = createTestHarness([
    {
      name: "gate",
      version: "1.0.0",
      hooks: ["onMessage"],
      onMessage() {
        return { block: true };
      },
    },
    {
      name: "later",
      version: "1.0.0",
      hooks: ["onMessage"],
      onMessage(_ctx, _ws, msg) {
        reached.push(msg);
      },
    },
  ]);

  const result = await h.call("onMessage", {}, { type: "chatmsg", text: "x" });
  assert.equal(result.blocked, true);
  assert.equal(result.msg, null);
  assert.deepEqual(reached, []);
});

await test("{ modify } payload reaches the next plugin", async () => {
  const seen = [];
  const h = createTestHarness([
    {
      name: "tagger",
      version: "1.0.0",
      hooks: ["onMessage"],
      onMessage(_ctx, _ws, msg) {
        return { modify: { ...msg, text: `pre ${msg.text}` } };
      },
    },
    {
      name: "capture",
      version: "1.0.0",
      hooks: ["onMessage"],
      onMessage(_ctx, _ws, msg) {
        seen.push(msg.text);
      },
    },
  ]);

  const result = await h.call("onMessage", {}, { type: "chatmsg", text: "hi" });
  assert.equal(result.blocked, false);
  assert.equal(result.msg.text, "pre hi");
  assert.deepEqual(seen, ["pre hi"]);
});

await test("example chat-tag plugin blocks empty chat and prefixes the tag", async () => {
  const h = createTestHarness(chatTag);
  await h.init();

  const empty = await h.call("onMessage", {}, { type: "chatmsg", text: "   " });
  assert.equal(empty.blocked, true, "whitespace-only chatmsg should be blocked");

  const missing = await h.call("onMessage", {}, { type: "chatmsg" });
  assert.equal(missing.blocked, true, "chatmsg without text should be blocked");

  const normal = await h.call("onMessage", {}, { type: "chatmsg", text: "hello" });
  assert.equal(normal.blocked, false);
  assert.equal(normal.msg.text, "[tag] hello");

  const other = await h.call("onMessage", {}, { type: "fs", path: "/tmp" });
  assert.equal(other.blocked, false);
  assert.equal(other.msg.text, undefined, "non-chatmsg payload must not be modified");

  const tagged = createTestHarness(chatTag, { config: { tag: "#desk" } });
  await tagged.init();
  const custom = await tagged.call("onMessage", {}, { type: "chatmsg", text: "hi" });
  assert.equal(custom.msg.text, "#desk hi");
});

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed ? 1 : 0);
