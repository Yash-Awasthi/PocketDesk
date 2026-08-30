/**
 * Plugin system for PocketDesk daemon.
 *
 * Inspired by deepseek-harness everything-is-a-plugin architecture
 * and claude-code-hermit extension/hook pattern.
 *
 * Plugins are JS files in daemon/src/plugins/ that export a manifest object.
 * Supported hooks: init, start, stop, onConnect, onDisconnect, onMessage,
 * onSessionCreated, onSessionExit, onChatCreated, onChatMessage.
 *
 * Hook return values:
 *   undefined - continue processing
 *   { block: true } - prevent message from reaching the handler
 *   { modify: {...} } - replace the message before handling
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_HOOKS = new Set([
  "init", "start", "stop",
  "onConnect", "onDisconnect", "onMessage",
  "onSessionCreated", "onSessionExit",
  "onChatCreated", "onChatMessage",
  "onProposal", "onProposalApproved", "onProposalRejected",
]);

/**
 * Validate a plugin manifest.
 * Returns { valid: true, plugin } or { valid: false, error }.
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
 * @param {object} ctx - Context passed to all plugin hooks.
 *   ctx.sessions, ctx.chat, ctx.broadcast, ctx.registry, ctx.config
 */
export function createPluginManager(ctx) {
  const plugins = [];  // { manifest, loaded }
  const hookCache = {};  // hookName -> [fn, ...]

  /**
   * Discover and load all plugins from a directory.
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

        const result = validateManifest(manifest, filePath);
        if (!result.valid) {
          console.error(`  plugin skip: ${result.error}`);
          continue;
        }

        plugins.push({ manifest: result.plugin, filePath });
        console.log(`  plugin loaded: ${result.plugin.name}@${result.plugin.version}`);
      } catch (err) {
        console.error(`  plugin error: ${entry.name}: ${err.message}`);
      }
    }

    // Build hook cache
    for (const p of plugins) {
      for (const hook of (p.manifest.hooks || [])) {
        if (!hookCache[hook]) hookCache[hook] = [];
        hookCache[hook].push({ name: p.manifest.name, fn: p.manifest[hook] });
      }
    }

    // Call init hooks
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
   * Call all hooks for a given event.
   * Returns { blocked: boolean, msg: object|null } — blocked if any plugin returned { block: true }.
   */
  async function callHook(hookName, ...args) {
    const hooks = hookCache[hookName];
    if (!hooks || hooks.length === 0) return { blocked: false, msg: null };

    let currentMsg = args[1]; // msg is usually the second arg (after ctx)
    for (const { name, fn } of hooks) {
      try {
        const result = await fn(ctx, ...args);
        if (result && result.block) {
          return { blocked: true, msg: null };
        }
        if (result && result.modify) {
          currentMsg = result.modify;
          args[1] = currentMsg;
        }
      } catch (err) {
        console.error(`  plugin hook error (${name}.${hookName}): ${err.message}`);
      }
    }
    return { blocked: false, msg: currentMsg };
  }

  /**
   * Call start hooks (after daemon is listening).
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
   * Call stop hooks (graceful shutdown).
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
    return plugins.map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      hooks: p.manifest.hooks || [],
    }));
  }

  return { discover, callHook, startAll, stopAll, list };
}
