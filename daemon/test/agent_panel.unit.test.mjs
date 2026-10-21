// Per-agent skills, commands and settings files, against a throwaway home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-panel-"));
const at = (...p) => path.join(tmp, ...p);
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
process.env.AH_HOME = tmp;
const { panel, readDoc, writeFile, docDescription, MASK } = await import("../src/agent_panel.js");

try {
  write(at(".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review the diff\n---\n# Review\n");
  write(at(".claude", "commands", "ship.md"), "Ship it now\n");
  write(at(".claude", "commands", "front", "lint.md"), "---\ndescription: \"Lint the UI\"\n---\nbody");
  write(at(".claude", "settings.json"), '{"a":1}');
  write(at("secret.txt"), "nope");

  const p = panel("claude");
  check("skills read their frontmatter description", p.skills[0]?.name === "review" && p.skills[0].description === "Review the diff");
  check("commands are namespaced by subfolder", p.commands.map((c) => c.name).join() === "front:lint,ship");
  check("listed files report whether they exist", p.files.find((f) => f.name === ".claude/settings.json")?.exists && !p.files.find((f) => f.name === ".claude/CLAUDE.md").exists);
  check("no file path reaches the phone", !JSON.stringify(p).includes(tmp.replaceAll("\\", "\\\\")));
  check("an unknown agent has no panel", !panel("nope").ok);

  check("a skill reads back", readDoc("claude", "skill", "review").content.includes("# Review"));
  check("a listed file reads back", readDoc("claude", "file", ".claude/settings.json").content === '{"a":1}');
  check("a missing listed file reads as empty", readDoc("claude", "file", ".claude/CLAUDE.md").content === "");
  check("an unlisted file is refused", !readDoc("claude", "file", "secret.txt").ok && !readDoc("claude", "file", "../secret.txt").ok);
  check("a traversal skill name is refused", !readDoc("claude", "skill", "../../secret.txt").ok);

  check("broken JSON is not written", !writeFile("claude", ".claude/settings.json", "{oops").ok && fs.readFileSync(at(".claude", "settings.json"), "utf8") === '{"a":1}');
  check("a listed file is written, creating it", writeFile("claude", ".claude/CLAUDE.md", "be terse").ok && fs.readFileSync(at(".claude", "CLAUDE.md"), "utf8") === "be terse");
  check("an unlisted file is never written", !writeFile("claude", "secret.txt", "x").ok && fs.readFileSync(at("secret.txt"), "utf8") === "nope");

  // Secrets never leave the PC: masked on read, the saved value kept when the mask comes back.
  write(at(".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-real", HOME_DIR: "x" }, model: "sonnet" }));
  const shown = readDoc("claude", "file", ".claude/settings.json").content;
  check("a token in settings.json is masked", !shown.includes("sk-real") && shown.includes(MASK) && shown.includes('"x"'));
  const edited = JSON.parse(shown); edited.model = "opus";
  check("saving the masked file keeps the real token", writeFile("claude", ".claude/settings.json", JSON.stringify(edited)).ok &&
    JSON.parse(fs.readFileSync(at(".claude", "settings.json"), "utf8")).env.CLAUDE_CODE_OAUTH_TOKEN === "sk-real");
  check("a mask with no saved value is refused", !writeFile("claude", ".claude/settings.json", JSON.stringify({ env: { NEW_API_KEY: MASK } })).ok);
  write(at(".codex", "config.toml"), 'model = "o3"\napi_key = "sk-toml"\n');
  const toml = readDoc("codex", "file", ".codex/config.toml").content;
  check("a TOML key is masked", !toml.includes("sk-toml") && toml.includes(MASK) && toml.includes('model = "o3"'));
  check("saving the masked TOML keeps the real key", writeFile("codex", ".codex/config.toml", toml.replace('"o3"', '"o4"')).ok &&
    fs.readFileSync(at(".codex", "config.toml"), "utf8") === 'model = "o4"\napi_key = "sk-toml"\n');

  check("description falls back to the first prose line", docDescription("\n# Title\nbody") === "Title");
  check("a folded YAML description is joined", docDescription("---\nname: x\ndescription: >\n  Two\n  lines\nother: y\n---\nbody") === "Two lines");
  check("a TOML command description is read", docDescription('description = "Do it"\nprompt = "x"') === "Do it");

  write(at(".claude", "plugins", "cache", "m", "p", "1.0", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  write(at(".claude", "plugins", "cache", "m", "p", "1.0", "skills", "lint", "SKILL.md"), "---\ndescription: Lint\n---\n");
  write(at(".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: at(".claude", "plugins", "cache", "m", "p", "1.0") }] } }));
  check("an installed plugin's skills are named plugin:skill", panel("claude").skills.some((s) => s.name === "kit:lint" && s.description === "Lint"));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
