/**
 * Plugin system for PocketDesk daemon.
 *
 * Inspired by deepseek-harness everything-is-a-plugin architecture
 * and claude-code-hermit extension/hook pattern.
 *
 * Plugins are JS files in daemon/src/plugins/ that export a manifest object.
 * Supported hooks: init, start, stop, onConnect, onDisconnect, onMessage,
 * onSessionCreated, onSessionExit, onChatCreated, onChatMessage, onProposal,
 * onProposalApproved, onProposalRejected.
 *
 * Lifecycle, in order:
 *   1. discover() imports each file and register()s it; a manifest is validated
 *      and its hooks are wired into the hook cache at that point.
 *   2. init hooks run in registration order (discover does this for you).
 *   3. start hooks run in registration order, after the daemon is listening.
 *   4. event hooks fire for the lifetime of the daemon.
 *   5. stop hooks run in registration order — deliberately not reversed, so a
 *      plugin that starts first also stops first.
 *
 * Every hook is called as `fn.call(manifest, ctx, ...args)`, so `this` is the
 * manifest and plugins can keep per-instance state on it.
 *
 * Hook return values:
 *   undefined        - continue, keep the current payload
 *   { block: true }  - stop delivery, nothing after this hook sees the event
 *   { modify: value } - replace the event payload (the second argument, after
 *                      ctx) for the next plugin and the eventual handler
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} PluginConfig
 * @property {number} [port]
 * @property {string} [token]
 * @property {string} [dataDir]
 */

/**
 * The context every plugin hook receives as its first argument.
 *
 * @typedef {object} PluginContext
 * @property {any} sessions
 * @property {any} chat
 * @property {any} registry
 * @property {any} proposals
 * @property {any} broadcast
 * @property {PluginConfig} config
 */

/**
 * @callback PluginHook
 * @param {PluginContext} ctx
 * @param {...any} args
 * @returns {any}
 */

/**
 * A plugin module's default export.
 *
 * @typedef {object} PluginManifest
 * @property {string} name
 * @property {string} version
 * @property {string[]} [hooks]
 * @property {PluginHook} [init]
 * @property {PluginHook} [start]
 * @property {PluginHook} [stop]
 * @property {PluginHook} [onConnect]
 * @property {PluginHook} [onDisconnect]
 * @property {PluginHook} [onMessage]
 * @property {PluginHook} [onSessionCreated]
 * @property {PluginHook} [onSessionExit]
 * @property {PluginHook} [onChatCreated]
 * @property {PluginHook} [onChatMessage]
 * @property {PluginHook} [onProposal]
 * @property {PluginHook} [onProposalApproved]
 * @property {PluginHook} [onProposalRejected]
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} valid
 * @property {PluginManifest} [plugin]
 * @property {string} [error]
 */

const VALID_HOOKS = new Set([
  "init",
  "start",
  "stop",
  "onConnect",
  "onDisconnect",
  "onMessage",
  "onSessionCreated",
  "onSessionExit",
  "onChatCreated",
  "onChatMessage",
  "onProposal",
  "onProposalApproved",
  "onProposalRejected",
]);

/**
 * Validate a plugin manifest.
 * Returns { valid: true, plugin } or { valid: false, error }.
 *
 * @param {any} manifest
 * @param {string} filePath
 * @returns {ValidationResult}
 */
function validateManifest(manifest, filePath) {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, error: `${filePath}: not an object` };
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    return { valid: false, error: `${filePath}: missing or invalid "name"` };
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    return { valid: false, error: `${filePath}: missing or invalid "version"` };
  }
  if (manifest.hooks && !Array.isArray(manifest.hooks)) {
    return { valid: false, error: `${filePath}: "hooks" must be an array` };
  }
  // Validate hook names
  if (manifest.hooks) {
    for (const hook of manifest.hooks) {
      if (!VALID_HOOKS.has(hook)) {
        return { valid: false, error: `${filePath}: unknown hook "${hook}"` };
      }
      if (typeof manifest[hook] !== "function") {
        return { valid: false, error: `${filePath}: hook "${hook}" declared but not a function` };
      }
    }
  }
  return { valid: true, plugin: manifest };
}

/**
 * Create a plugin manager.
 *
 * @param {PluginContext} ctx - Context passed to all plugin hooks:
 *   ctx.sessions, ctx.chat, ctx.registry, ctx.proposals, ctx.broadcast, ctx.config
 */
export function createPluginManager(ctx) {
  /** @type {Array<{ manifest: PluginManifest, filePath: string }>} */
  const plugins = [];
  /** @type {Record<string, Array<{ name: string, manifest: PluginManifest, fn: PluginHook }>>} */
  const hookCache = {};

  /**
   * Validate and register one manifest, wiring its hooks into the hook cache.
   * Registration order is the order hooks will run in.
   * Call initAll() afterwards to run init hooks.
   *
   * @param {any} manifest
   * @param {string} filePath
   * @returns {ValidationResult}
   */
  function register(manifest, filePath) {
    const result = validateManifest(manifest, filePath);
    if (!result.plugin) return result;

    const plugin = result.plugin;
    plugins.push({ manifest: plugin, filePath });

    for (const hook of plugin.hooks || []) {
      if (!hookCache[hook]) hookCache[hook] = [];
      // Keep the manifest so the hook can be invoked with `this` bound —
      // plugins hold per-instance state (e.g. logger._stream) on `this`.
      hookCache[hook].push({ name: plugin.name, manifest: plugin, fn: plugin[hook] });
    }
    return result;
  }

  /**
   * Run init hooks in registration order.
   */
  async function initAll() {
    for (const p of plugins) {
      if (p.manifest.init) {
        try {
          await p.manifest.init(ctx);
        } catch (err) {
          console.error(`  plugin init error (${p.manifest.name}): ${err.message}`);
        }
      }
    }
  }

  /**
   * Discover, register and initialize all plugins from a directory.
   */
  async function discover(pluginDir) {
    if (!fs.existsSync(pluginDir)) return;

    const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

      const filePath = path.join(pluginDir, entry.name);
      try {
        const mod = await import(pathToFileURL(filePath).href);
        const manifest = mod.default || mod;

        const result = register(manifest, filePath);
        if (!result.plugin) {
          console.error(`  plugin skip: ${result.error}`);
          continue;
        }
        console.log(`  plugin loaded: ${result.plugin.name}@${result.plugin.version}`);
      } catch (err) {
        console.error(`  plugin error: ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await initAll();
  }

  /**
   * Call all hooks for a given event.
   * Returns { blocked: boolean, msg: object|null } — blocked if any plugin returned { block: true }.
   */
  async function callHook(hookName, ...args) {
    const hooks = hookCache[hookName];
    if (!hooks || hooks.length === 0) return { blocked: false, msg: null };

    let currentMsg = args[1]; // msg is usually the second arg (after ctx)
    for (const { name, manifest, fn } of hooks) {
      try {
        const result = await fn.call(manifest, ctx, ...args);
        if (result && result.block) {
          return { blocked: true, msg: null };
        }
        if (result && result.modify) {
          currentMsg = result.modify;
          args[1] = currentMsg;
        }
      } catch (err) {
        console.error(
          `  plugin hook error (${name}.${hookName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { blocked: false, msg: currentMsg };
  }

  /**
   * Call start hooks (after daemon is listening), in registration order.
   */
  async function startAll() {
    for (const p of plugins) {
      if (p.manifest.start) {
        try {
          await p.manifest.start(ctx);
        } catch (err) {
          console.error(`  plugin start error (${p.manifest.name}): ${err.message}`);
        }
      }
    }
  }

  /**
   * Call stop hooks (graceful shutdown), in registration order — not reversed.
   */
  async function stopAll() {
    for (const p of plugins) {
      if (p.manifest.stop) {
        try {
          await p.manifest.stop(ctx);
        } catch (err) {
          console.error(`  plugin stop error (${p.manifest.name}): ${err.message}`);
        }
      }
    }
  }

  /**
   * List loaded plugins.
   */
  function list() {
    return plugins.map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      hooks: p.manifest.hooks || [],
    }));
  }

  return { discover, register, initAll, callHook, startAll, stopAll, list };
}

/**
 * Mock context for tests and examples: no daemon, no filesystem.
 *
 * @param {any} [overrides]
 * @returns {PluginContext}
 */
function mockContext(overrides) {
  const config = { port: 8765, token: "test-token", dataDir: ".pocketdesk-test" };
  return {
    sessions: { summary: () => [] },
    chat: { summary: () => [] },
    registry: { list: () => [] },
    proposals: { list: () => [] },
    broadcast: () => {},
    ...overrides,
    // config merges so a test can add e.g. `tag` without dropping port/token.
    config: { ...config, ...(overrides?.config || {}) },
  };
}

/**
 * Build a plugin manager around a mock context so hooks can be exercised
 * without a running daemon or any filesystem access.
 *
 * Every init/start/stop/call is recorded on `events` as { hook, args }, in
 * order, so lifecycle tests can assert what ran and in which order.
 *
 * @param {PluginManifest | PluginManifest[]} pluginOrArray
 * @param {any} [ctxOverrides] - shallow overrides for the mock ctx; `config` is merged.
 * @returns {{
 *   ctx: PluginContext,
 *   manager: ReturnType<typeof createPluginManager>,
 *   events: Array<{ hook: string, args: any[] }>,
 *   init: () => Promise<void>,
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   call: (hook: string, ...args: any[]) => Promise<{ blocked: boolean, msg: any }>,
 *   list: () => Array<{ name: string, version: string, hooks: string[] }>,
 * }}
 */
export function createTestHarness(pluginOrArray, ctxOverrides) {
  const ctx = mockContext(ctxOverrides);
  const manager = createPluginManager(ctx);
  /** @type {Array<{ hook: string, args: any[] }>} */
  const events = [];

  const manifests = Array.isArray(pluginOrArray) ? pluginOrArray : [pluginOrArray];
  for (const manifest of manifests) {
    const result = manager.register(manifest, "<harness>");
    if (!result.plugin) throw new Error(result.error || "invalid plugin manifest");
  }

  return {
    ctx,
    manager,
    events,
    async init() {
      events.push({ hook: "init", args: [ctx] });
      await manager.initAll();
    },
    async start() {
      events.push({ hook: "start", args: [ctx] });
      await manager.startAll();
    },
    async stop() {
      events.push({ hook: "stop", args: [ctx] });
      await manager.stopAll();
    },
    async call(hook, ...args) {
      events.push({ hook, args: [ctx, ...args] });
      return manager.callHook(hook, ...args);
    },
    list: () => manager.list(),
  };
}
