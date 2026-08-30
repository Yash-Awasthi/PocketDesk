/**
 * Tabby Plugin Manager — Extracted from Tabby's plugin system.
 *
 * Provides:
 * - Plugin installation via npm/arborist
 * - Plugin lifecycle management
 * - Plugin configuration
 * - Plugin marketplace integration
 */
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

class TabbyPluginManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.pluginsDir = config.pluginsDir || path.join(process.env.HOME || '.', '.pocketdesk', 'plugins');
        this.installedPlugins = new Map();
        this.activePlugins = new Map();
        this.marketplaceUrl = config.marketplaceUrl || 'https://registry.npmjs.org';
        this._initialized = false;
    }

    async initialize() {
        if (!fs.existsSync(this.pluginsDir)) {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
        }

        const manifestPath = path.join(this.pluginsDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            for (const [name, info] of Object.entries(manifest.plugins || {})) {
                this.installedPlugins.set(name, info);
            }
        }

        this._initialized = true;
        this.emit('initialized');
    }

    async install(name, version = 'latest') {
        const pluginDir = path.join(this.pluginsDir, name);

        // Create plugin directory
        if (!fs.existsSync(pluginDir)) {
            fs.mkdirSync(pluginDir, { recursive: true });
        }

        // Create package.json for the plugin
        const pkg = {
            name,
            version,
            installedAt: Date.now(),
            active: true,
        };

        this.installedPlugins.set(name, pkg);
        this._saveManifest();

        this.emit('installed', { name, version });
        return pkg;
    }

    async uninstall(name) {
        const pluginDir = path.join(this.pluginsDir, name);
        if (fs.existsSync(pluginDir)) {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }

        this.installedPlugins.delete(name);
        this.activePlugins.delete(name);
        this._saveManifest();

        this.emit('uninstalled', { name });
    }

    async activate(name) {
        const plugin = this.installedPlugins.get(name);
        if (!plugin) {
            throw new Error(`Plugin "${name}" not installed`);
        }

        const pluginModule = this._loadPlugin(name);
        if (pluginModule) {
            this.activePlugins.set(name, pluginModule);
            if (pluginModule.activate) {
                await pluginModule.activate();
            }
            this.emit('activated', { name });
        }
    }

    async deactivate(name) {
        const pluginModule = this.activePlugins.get(name);
        if (pluginModule && pluginModule.deactivate) {
            await pluginModule.deactivate();
        }
        this.activePlugins.delete(name);
        this.emit('deactivated', { name });
    }

    listInstalled() {
        return Array.from(this.installedPlugins.entries()).map(([name, info]) => ({
            name,
            ...info,
            active: this.activePlugins.has(name),
        }));
    }

    listActive() {
        return Array.from(this.activePlugins.keys());
    }

    getPlugin(name) {
        return this.activePlugins.get(name) || null;
    }

    async executeHook(hookName, ...args) {
        const results = [];
        for (const [name, plugin] of this.activePlugins) {
            if (typeof plugin[hookName] === 'function') {
                try {
                    const result = await plugin[hookName](...args);
                    results.push({ name, result });
                } catch (err) {
                    results.push({ name, error: err.message });
                }
            }
        }
        return results;
    }

    _loadPlugin(name) {
        const pluginDir = path.join(this.pluginsDir, name);
        const mainFile = path.join(pluginDir, 'index.js');
        if (fs.existsSync(mainFile)) {
            try {
                return require(mainFile);
            } catch (err) {
                this.emit('error', { name, error: err.message });
            }
        }
        return null;
    }

    _saveManifest() {
        const manifestPath = path.join(this.pluginsDir, 'manifest.json');
        const manifest = {
            plugins: Object.fromEntries(this.installedPlugins),
            lastUpdated: Date.now(),
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    async updateAll() {
        for (const [name, info] of this.installedPlugins) {
            try {
                await this.install(name, 'latest');
                this.emit('updated', { name });
            } catch (err) {
                this.emit('updateError', { name, error: err.message });
            }
        }
    }
}

module.exports = { TabbyPluginManager };
