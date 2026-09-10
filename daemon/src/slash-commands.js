/**
 * Slash Commands — Handle /commands in chat messages.
 * Inspired by claude-remote-terminal's slash commands.
 */
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";
import * as registry from "./registry.js";

const commands = new Map();

function register(name, description, handler) {
  commands.set(name, { name, description, handler });
}

register("help", "List all available slash commands", () => {
  const list = [...commands.values()].map((c) => `/${c.name} — ${c.description}`);
  return list.join("\n");
});

register("status", "Show session status summary", () => {
  const all = [...sessions.summary(), ...chat.summary()];
  const running = all.filter((s) => s.state === "running").length;
  const idle = all.filter((s) => s.state === "idle").length;
  return `Sessions: ${all.length} total, ${running} running, ${idle} idle`;
});

register("sessions", "List all active sessions", () => {
  const all = [...sessions.summary(), ...chat.summary()];
  if (!all.length) return "No active sessions.";
  return all.map((s) => `  ${s.id} [${s.harnessId}] ${s.cwd || ""} — ${s.state || "active"}`).join("\n");
});

register("agents", "List available agent manifests", () => {
  const manifests = registry.list();
  if (!manifests.length) return "No agents found.";
  return manifests.map((m) => `  ${m.manifest.id} — ${m.manifest.name} ${m.installed ? "✓" : "✗"}`).join("\n");
});

register("clear", "Clear the current chat transcript", (args, chatId) => {
  const c = chat.get(chatId);
  if (c) {
    c.transcript = [];
    return "Transcript cleared.";
  }
  return "No active chat session.";
});

register("rename", "Rename a session", (args, chatId) => {
  const newName = args.join(" ").trim();
  if (!newName) return "Usage: /rename <name>";
  const c = chat.get(chatId);
  if (c) {
    c.name = newName;
    return `Session renamed to "${newName}".`;
  }
  return "No active chat session.";
});

register("kill", "Kill a session by ID", (args) => {
  const id = args[0];
  if (!id) return "Usage: /kill <session-id>";
  const s = sessions.get(id);
  if (s) {
    sessions.kill(id);
    return `Session ${id} killed.`;
  }
  return `Session ${id} not found.`;
});

export function handle(text, chatId) {
  if (!text.startsWith("/")) return null;
  const parts = text.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  const cmd = commands.get(name);
  if (!cmd) return `Unknown command: /${name}. Type /help for available commands.`;

  try {
    return cmd.handler(args, chatId);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

export function listCommands() {
  return [...commands.values()].map((c) => ({ name: c.name, description: c.description }));
}
