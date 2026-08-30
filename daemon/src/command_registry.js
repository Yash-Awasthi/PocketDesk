/**
 * Command Registry - Plugin command registration system.
 * Extracted from terminai (inspiration).
 * Register, discover, and execute commands with aliases and help.
 */

export class Command {
  constructor(config) {
    this.name = config.name;
    this.description = config.description || '';
    this.aliases = config.aliases || [];
    this.usage = config.usage || `/${config.name}`;
    this.subCommands = config.subCommands || [];
    this.handler = config.handler || (() => {});
    this.requiresAuth = config.requiresAuth || false;
    this.category = config.category || 'general';
  }

  matches(input) {
    const clean = input.trim().toLowerCase();
    if (clean === `/${this.name}` || clean.startsWith(`/${this.name} `)) {
      return true;
    }
    return this.aliases.some(alias => clean === `/${alias}` || clean.startsWith(`/${alias} `));
  }

  parseArgs(input) {
    const parts = input.trim().split(/\s+/);
    const subCommand = parts.length > 1 ? parts[1] : null;
    const args = parts.slice(2);
    return { subCommand, args, raw: input };
  }

  async execute(input, context) {
    const parsed = this.parseArgs(input);
    return this.handler(parsed, context);
  }
}

export class CommandRegistry {
  constructor() {
    this.commands = new Map();
    this.categories = new Map();
  }

  register(command) {
    if (command instanceof Command) {
      this.commands.set(command.name, command);
      for (const alias of command.aliases) {
        this.commands.set(alias, command);
      }
      if (command.subCommands) {
        for (const sub of command.subCommands) {
          this.register(sub);
        }
      }
      if (!this.categories.has(command.category)) {
        this.categories.set(command.category, []);
      }
      this.categories.get(command.category).push(command);
      return true;
    }
    return false;
  }

  unregister(name) {
    const cmd = this.commands.get(name);
    if (cmd) {
      this.commands.delete(name);
      for (const alias of cmd.aliases) {
        this.commands.delete(alias);
      }
      const cat = this.categories.get(cmd.category);
      if (cat) {
        const idx = cat.indexOf(cmd);
        if (idx >= 0) cat.splice(idx, 1);
      }
      return true;
    }
    return false;
  }

  get(name) {
    return this.commands.get(name) || null;
  }

  findCommand(input) {
    const clean = input.trim().toLowerCase();
    for (const [name, cmd] of this.commands) {
      if (cmd.matches(clean)) return cmd;
    }
    return null;
  }

  async execute(input, context) {
    const cmd = this.findCommand(input);
    if (!cmd) return { success: false, error: `Unknown command: ${input.split(' ')[0]}` };
    if (cmd.requiresAuth && (!context || !context.isAuthenticated)) {
      return { success: false, error: 'Authentication required' };
    }
    try {
      const result = await cmd.execute(input, context);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  listByCategory(category) {
    return this.categories.get(category) || [];
  }

  listAll() {
    const seen = new Set();
    const result = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  getHelp() {
    const categories = {};
    for (const [cat, cmds] of this.categories) {
      categories[cat] = cmds.map(c => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        aliases: c.aliases,
      }));
    }
    return categories;
  }

  search(query) {
    const q = query.toLowerCase();
    return this.listAll().filter(cmd =>
      cmd.name.includes(q) ||
      cmd.description.toLowerCase().includes(q) ||
      cmd.aliases.some(a => a.includes(q))
    );
  }
}

export function createHelpCommand(registry) {
  return new Command({
    name: 'help',
    description: 'Show available commands',
    aliases: ['h', '?'],
    usage: '/help [command]',
    category: 'system',
    handler: (parsed, context) => {
      if (parsed.subCommand) {
        const cmd = registry.get(parsed.subCommand);
        if (cmd) {
          return {
            name: cmd.name,
            description: cmd.description,
            usage: cmd.usage,
            aliases: cmd.aliases,
            category: cmd.category,
          };
        }
        return { error: `Command not found: ${parsed.subCommand}` };
      }
      return registry.getHelp();
    },
  });
}

export function createListCommandsCommand(registry) {
  return new Command({
    name: 'commands',
    description: 'List all available commands',
    aliases: ['ls'],
    category: 'system',
    handler: () => {
      return registry.listAll().map(cmd => ({
        name: `/${cmd.name}`,
        description: cmd.description,
        category: cmd.category,
      }));
    },
  });
}
