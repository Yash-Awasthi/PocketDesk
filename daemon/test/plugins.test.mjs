import { describe, it, expect, vi } from "vitest";
import { createPluginManager } from "../src/plugins.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mockCtx() {
  return {
    sessions: { summary: () => [] },
    chat: { summary: () => [] },
    registry: { list: () => [] },
    broadcast: vi.fn(),
    config: { port: 8765, token: "test-token" },
  };
}

const PLUGIN_DIR = path.join(__dirname, "..", "src", "plugins");

describe("plugin discovery", () => {
  it("loads plugins from plugins directory", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const loaded = pm.list();
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    const names = loaded.map(p => p.name);
    expect(names).toContain("logger");
    expect(names).toContain("metrics");
    expect(names).toContain("auth");
  });

  it("handles missing directory gracefully", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover("/nonexistent/path");
    expect(pm.list().length).toBe(0);
  });
});

describe("hook firing", () => {
  it("fires onConnect hook without error", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const ws = { _subs: new Set(), _authed: false, readyState: 1 };
    await pm.callHook("onConnect", ws);
  });

  it("fires onMessage hook for each message", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const ws = { _subs: new Set(), _authed: true, readyState: 1 };
    const msg = { type: "chatmsg", id: "c1", text: "hello" };
    const { blocked } = await pm.callHook("onMessage", ws, msg);
    expect(blocked).toBe(false);
  });

  it("blocks unauthenticated messages via auth plugin", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const ws = { _subs: new Set(), _authed: false, readyState: 1 };
    const msg = { type: "chatmsg", text: "hello" };
    const { blocked } = await pm.callHook("onMessage", ws, msg);
    expect(blocked).toBe(true);
  });

  it("passes through authenticated messages", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const ws = { _subs: new Set(), _authed: true, readyState: 1 };
    const msg = { type: "fs", path: "/tmp" };
    const { blocked } = await pm.callHook("onMessage", ws, msg);
    expect(blocked).toBe(false);
  });
});

describe("plugin lifecycle", () => {
  it("calls startAll and stopAll without error", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    await pm.startAll();
    await pm.stopAll();
  });

  it("list returns plugin metadata", async () => {
    const pm = createPluginManager(mockCtx());
    await pm.discover(PLUGIN_DIR);
    const list = pm.list();
    for (const p of list) {
      expect(p.name).toBeDefined();
      expect(p.version).toBeDefined();
      expect(Array.isArray(p.hooks)).toBe(true);
    }
  });
});
