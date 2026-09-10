/**
 * Plugin system tests.
 * Run with: node test/plugins.test.mjs
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginManager } from "../src/plugins.js";

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

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed ? 1 : 0);
