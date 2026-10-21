/**
 * One control panel for every coding agent: its skills, its custom slash commands and its own
 * settings and memory files, read and edited from the phone. Each agent is a table entry, so
 * adding one is a line here, not a module.
 *
 * Only names listed below are ever opened: the phone sends an agent id and a file or skill name,
 * never a path. AH_HOME relocates home (tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic_write.js";

const home = () => process.env.AH_HOME || os.homedir();
const MAX_FILE = 256 << 10;

/** skills: folders of <name>/SKILL.md; commands: folders of <name>.md (or .toml); files: editable by name. */
const AGENTS = {
  claude: { skills: [".claude/skills"], commands: [".claude/commands"], plugins: ".claude/plugins/installed_plugins.json", files: [".claude/settings.json", ".claude/CLAUDE.md"] },
  codex: { skills: [".codex/skills"], commands: [".codex/prompts"], files: [".codex/config.toml", ".codex/AGENTS.md"] },
  gemini: { commands: [".gemini/commands"], files: [".gemini/settings.json", ".gemini/GEMINI.md"] },
  qwen: { commands: [".qwen/commands"], files: [".qwen/settings.json", ".qwen/QWEN.md"] },
  opencode: { commands: [".config/opencode/command"], files: [".config/opencode/opencode.json", ".config/opencode/AGENTS.md"] },
  copilot: { files: [".copilot/config.json", ".copilot/mcp-config.json"] },
  cline: { files: [".cline/data/settings/cline_mcp_settings.json"] },
};

export const supported = (agent) => Object.hasOwn(AGENTS, agent);

/** A doc's description: the frontmatter `description:`, else its first prose line. */
export function docDescription(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  // YAML inline or folded (`description: >` then indented lines); TOML commands use `description = "..."`.
  const d = (fm && /^description:[ \t]*(?:[>|][-+]?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)|["']?(.+?)["']?[ \t]*$)/m.exec(fm[1]))
    || /^description\s*=\s*"(.*)"\s*$/m.exec(text);
  const desc = d && (d[2] ?? d[1]);
  if (desc) return desc.replace(/\s+/g, " ").trim().slice(0, 160);
  const body = fm ? text.slice(fm[0].length) : text;
  return (body.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 160);
}

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const entries = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

/** Installed plugins as [name prefix, folder]: their skills and commands are "<plugin>:<name>". */
function plugins(spec) {
  if (!spec.plugins) return [];
  const installed = (() => { try { return JSON.parse(read(path.join(home(), spec.plugins)) ?? "{}").plugins ?? {}; } catch { return {}; } })();
  return Object.entries(installed).flatMap(([id, installs]) => {
    const dir = Array.isArray(installs) ? installs.at(-1)?.installPath : null;
    if (typeof dir !== "string") return [];
    let name = id.split("@")[0];
    try { name = JSON.parse(read(path.join(dir, ".claude-plugin", "plugin.json")) ?? "{}").name || name; } catch {}
    return [[`${name}:`, dir]];
  });
}

function skills(spec) {
  const out = [];
  const scan = (dir, prefix) => {
    for (const e of entries(dir)) {
      const md = path.join(dir, e.name, "SKILL.md");
      const text = e.isDirectory() ? read(md) : null;
      if (text != null && !out.some((s) => s.name === prefix + e.name)) out.push({ name: prefix + e.name, description: docDescription(text), file: md });
    }
  };
  for (const rel of spec.skills ?? []) scan(path.join(home(), rel), "");
  for (const [prefix, dir] of plugins(spec)) scan(path.join(dir, "skills"), prefix);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function commands(spec) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of entries(dir)) {
      const p = path.join(dir, e.name);
      // A subfolder namespaces its commands: frontend/review.md is /frontend:review.
      if (e.isDirectory()) walk(p, `${prefix}${e.name}:`);
      else if (/\.(md|toml)$/.test(e.name)) out.push({ name: prefix + e.name.replace(/\.(md|toml)$/, ""), description: docDescription(read(p) ?? ""), file: p });
    }
  };
  for (const rel of spec.commands ?? []) walk(path.join(home(), rel), "");
  for (const [prefix, dir] of plugins(spec)) walk(path.join(dir, "commands"), prefix);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills, commands and the editable files (with whether each exists yet) for one agent. */
export function panel(agent) {
  const spec = AGENTS[agent];
  if (!spec) return { ok: false, error: `no panel for ${agent}` };
  const strip = ({ file, ...x }) => x;
  return {
    ok: true,
    agent,
    skills: skills(spec).map(strip),
    commands: commands(spec).map(strip),
    files: (spec.files ?? []).map((name) => {
      const st = fs.statSync(path.join(home(), name), { throwIfNoEntry: false });
      return { name, exists: !!st, size: st?.size ?? 0 };
    }),
  };
}

// Settings files hold login tokens and API keys (Claude Code keeps CLAUDE_CODE_OAUTH_TOKEN in
// settings.json): they are masked before a file leaves the PC and put back when it is saved.
const SECRET = /(token|secret|passw(or)?d|api[_-]?key|private[_-]?key|credential)/i;
export const MASK = "•••• hidden on the PC";

function maskJson(v, key = "") {
  if (typeof v === "string") return SECRET.test(key) && v ? MASK : v;
  if (Array.isArray(v)) return v.map((x) => maskJson(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskJson(x, k)]));
  return v;
}

/** Puts the saved value back wherever the phone sent the mask; false when a masked key has no saved value. */
function unmaskJson(next, prev) {
  let ok = true;
  const walk = (n, p) => {
    if (!n || typeof n !== "object") return n;
    for (const k of Object.keys(n)) {
      if (n[k] === MASK) {
        if (typeof p?.[k] === "string") n[k] = p[k];
        else ok = false;
      } else n[k] = walk(n[k], p?.[k]);
    }
    return n;
  };
  return { value: walk(next, prev), ok };
}

const TOML_SECRET = new RegExp(`^(\\s*([\\w.-]*${SECRET.source}[\\w.-]*)\\s*=\\s*)"([^"]*)"`, "gim");

function mask(name, text) {
  if (name.endsWith(".json")) try {
    const parsed = JSON.parse(text);
    const masked = maskJson(parsed);
    // Untouched files keep their own formatting.
    return JSON.stringify(masked) === JSON.stringify(parsed) ? text : JSON.stringify(masked, null, 2);
  } catch { return text; }
  if (name.endsWith(".toml")) return text.replace(TOML_SECRET, (m, head, key, _a, _b, v) => (v ? `${head}"${MASK}"` : m));
  return text;
}

function unmask(name, text, saved) {
  if (!text.includes(MASK)) return { text, ok: true };
  if (name.endsWith(".json")) {
    const r = unmaskJson(JSON.parse(text), (() => { try { return JSON.parse(saved); } catch { return null; } })());
    return { text: JSON.stringify(r.value, null, 2) + "\n", ok: r.ok };
  }
  if (name.endsWith(".toml")) {
    const old = new Map([...saved.matchAll(TOML_SECRET)].map((m) => [m[2], m[5]]));
    let ok = true;
    const out = text.replace(TOML_SECRET, (m, head, key, _a, _b, v) => {
      if (v !== MASK) return m;
      if (!old.has(key)) { ok = false; return m; }
      return `${head}"${old.get(key)}"`;
    });
    return { text: out, ok };
  }
  return { text, ok: false };
}

/** The text of a skill, command or listed file, by kind and name. */
export function readDoc(agent, kind, name) {
  const spec = AGENTS[agent];
  if (!spec) return { ok: false, error: `no panel for ${agent}` };
  const file = kind === "file" ? (spec.files?.includes(name) ? path.join(home(), name) : null)
    : (kind === "skill" ? skills(spec) : commands(spec)).find((x) => x.name === name)?.file;
  if (!file) return { ok: false, error: `unknown ${kind}: ${name}` };
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (st && st.size > MAX_FILE) return { ok: false, error: "too large to edit from the phone" };
  const content = st ? read(file) ?? "" : "";
  return { ok: true, agent, kind, name, content: kind === "file" ? mask(name, content) : content };
}

/** Replaces a listed file (creating it if needed). JSON files must still parse, or the agent would not start. */
export function writeFile(agent, name, content) {
  const spec = AGENTS[agent];
  if (!spec?.files?.includes(name)) return { ok: false, error: `not an editable file: ${name}` };
  let text = String(content ?? "");
  if (Buffer.byteLength(text) > MAX_FILE) return { ok: false, error: "too large" };
  if (name.endsWith(".json")) try { JSON.parse(text); } catch (e) { return { ok: false, error: `not valid JSON: ${e.message}` }; }
  const file = path.join(home(), name);
  const restored = unmask(name, text, read(file) ?? "");
  if (!restored.ok) return { ok: false, error: "a hidden value has nothing saved on the PC to keep; type the real value instead" };
  text = restored.text;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text);
    return { ok: true, agent, name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
