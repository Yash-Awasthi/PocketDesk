#!/usr/bin/env node
// Captures a golden transcript per installed agent CLI into docs/transcripts/<id>/.
//
// Three captures per agent: --version, --help, and one non-interactive prompt
// attempt made with no credentials. The prompt attempt is the credential probe:
// if the CLI cannot answer without a key or a TTY its refusal is the transcript,
// verbatim. Nothing here fabricates a conversation or uses a stored account.
//
// Run from the repo root: node docs/transcripts/capture.mjs

process.noDeprecation = true;

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const OUT = path.join(ROOT, "docs", "transcripts");
const CWD = path.join(os.tmpdir(), "pocketdesk-transcripts-cwd");
const CAPTURED = new Date().toISOString().slice(0, 10);

const AGENTS = [
  {
    id: "claude-code",
    title: "Claude Code",
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    probe: ["-p", "Reply with OK", "--output-format", "stream-json", "--verbose"],
    note: "plain -p without --output-format prints the same refusal on stderr",
  },
  {
    id: "codex",
    title: "OpenAI Codex CLI",
    bin: "codex",
    pkg: "@openai/codex",
    probe: ["exec", "--json", "--skip-git-repo-check", "Reply with OK"],
    // An empty CODEX_HOME keeps the owner's stored ChatGPT token out of the probe.
    env: { CODEX_HOME: path.join(CWD, "codex-home") },
    note: "CODEX_HOME points at an empty directory so no stored token is used",
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    bin: "gemini",
    pkg: "@google/gemini-cli",
    probe: ["-p", "Reply with OK", "-o", "stream-json"],
    note: "no GEMINI_API_KEY, GOOGLE_API_KEY or oauth_creds.json on this machine",
  },
  {
    id: "qwen",
    title: "Qwen Code",
    bin: "qwen",
    pkg: "@qwen-code/qwen-code",
    probe: ["-p", "Reply with OK", "-o", "stream-json"],
    note: "no QWEN_API_KEY, DASHSCOPE_API_KEY or ~/.qwen on this machine",
  },
  {
    id: "opencode",
    title: "OpenCode",
    bin: "opencode",
    pkg: "opencode-ai",
    probe: ["run", "--format", "json", "Reply with OK"],
    env: {
      XDG_CONFIG_HOME: path.join(CWD, "opencode-config"),
      XDG_DATA_HOME: path.join(CWD, "opencode-data"),
    },
    note: "XDG dirs point at empty directories so no stored provider credential is used",
  },
  {
    id: "copilot",
    title: "GitHub Copilot CLI",
    bin: "copilot",
    pkg: "@github/copilot",
    probe: ["-p", "Reply with OK", "--output-format", "json"],
    note: "gh keyring token is reported invalid by `gh auth status`; no GITHUB_TOKEN set",
  },
  {
    id: "cline",
    title: "Cline CLI",
    bin: "cline",
    pkg: "cline",
    probe: ["--json", "Reply with OK"],
    note: "no provider key configured for cline",
  },
];

function npmRoot() {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  return r.stdout.trim();
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(p);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += fs.statSync(p).size;
      files++;
    }
  }
  return { bytes, files };
}

function quote(a) {
  return /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a;
}

function run(argv, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"]) {
    delete env[k];
  }
  const started = Date.now();
  const r = spawnSync(argv.map(quote).join(" "), {
    cwd: CWD,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
    windowsHide: true,
  });
  return {
    stdout: r.stdout ? r.stdout.toString("utf8") : "",
    stderr: r.stderr ? r.stderr.toString("utf8") : "",
    status: r.status,
    signal: r.signal,
    timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
    ms: Date.now() - started,
  };
}

function transcript(agent, label, argv, result, extraEnv) {
  const envLine = extraEnv && Object.keys(extraEnv).length
    ? Object.entries(extraEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "none";
  const outcome = result.timedOut
    ? "timeout after 90s (killed)"
    : result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
  const head = [
    `# Golden transcript: ${agent.title} (${agent.id})`,
    `# package: ${agent.pkg}`,
    `# binary: ${agent.bin}`,
    `# command: ${[agent.bin, ...argv].map(quote).join(" ")}`,
    `# argv: ${JSON.stringify([agent.bin, ...argv])}`,
    `# cwd: ${CWD}`,
    `# env-overrides: ${envLine}`,
    `# credential-probe: ${label === "print" ? "yes, no credentials supplied" : "no"}`,
    `# outcome: ${outcome} in ${result.ms} ms`,
    `# captured: ${CAPTURED}`,
    "",
  ];
  if (agent.note && label === "print") head.push(`# note: ${agent.note}`, "");
  const body = [
    ...head,
    "# ---- stdout ----",
    ...(result.stdout ? result.stdout.replace(/\n$/, "").split("\n") : ["(empty)"]),
    "# ---- stderr ----",
    ...(result.stderr ? result.stderr.replace(/\n$/, "").split("\n") : ["(empty)"]),
    "# ---- end ----",
    "",
  ];
  fs.writeFileSync(path.join(OUT, agent.id, label + ".txt"), body.join("\n"));
}

fs.mkdirSync(CWD, { recursive: true });
for (const a of AGENTS) fs.mkdirSync(path.join(OUT, a.id), { recursive: true });
for (const a of AGENTS) {
  for (const d of Object.values(a.env || {})) fs.mkdirSync(d, { recursive: true });
}

const root = npmRoot();
const manifest = { captured: CAPTURED, npmGlobalRoot: root, agents: [] };

for (const a of AGENTS) {
  const dir = path.join(root, a.pkg);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const size = dirSize(dir);
  const entry = {
    id: a.id,
    title: a.title,
    package: a.pkg,
    version: pkgJson.version,
    installPath: dir,
    diskBytes: size.bytes,
    diskMB: Math.round((size.bytes / 1024 / 1024) * 10) / 10,
    files: size.files,
  };
  manifest.agents.push(entry);

  transcript(a, "version", ["--version"], run([a.bin, "--version"], a.env), a.env);
  transcript(a, "help", ["--help"], run([a.bin, "--help"], a.env), a.env);
  transcript(a, "print", a.probe, run([a.bin, ...a.probe], a.env), a.env);
  console.log(`${a.id}: ${pkgJson.version} ${entry.diskMB} MB`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${path.relative(ROOT, OUT)}`);
