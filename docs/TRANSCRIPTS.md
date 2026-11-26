# Golden agent transcripts

Captured 2026-11-26 on Windows 11, Node 26.8.1, npm 11.19.0. One directory per
CLI under `docs/transcripts/<agent>/`, each holding three files:

| file | what it is |
|---|---|
| `version.txt` | `<bin> --version`, verbatim |
| `help.txt` | `<bin> --help`, verbatim |
| `print.txt` | one non-interactive prompt attempt with no credentials supplied |

Every file starts with a header block naming the exact argv, the package
version, the working directory, any environment override, and the exit code or
timeout. Everything between `# ---- stdout ----` and `# ---- end ----` is the
CLI's own bytes, unedited.

Regenerate with `node docs/transcripts/capture.mjs` from the repo root. The
script reads each package's `package.json` for its version, measures the
installed tree, and writes `manifest.json`. It deletes every provider key from
the child environment and points `CODEX_HOME`, `XDG_CONFIG_HOME` and
`XDG_DATA_HOME` at empty directories, so no stored account is used.

## Installed CLIs

Global prefix: `C:\Users\Yash\AppData\Roaming\npm` (packages under
`...\npm\node_modules`). Shims: `claude.ps1`, `codex.ps1`, `gemini.ps1`,
`qwen.ps1`, `opencode.ps1`, `copilot.ps1`, `cline.ps1`.

| agent | package | version | size | first `--version` line |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | 2.1.332 | 769 MB | `2.1.332 (Claude Code)` |
| Codex | `@openai/codex` | 0.172.0 | 523.2 MB | `codex-cli 0.172.0` |
| Gemini CLI | `@google/gemini-cli` | 0.71.1 | 128.7 MB | `0.71.1` |
| Qwen Code | `@qwen-code/qwen-code` | 0.28.6 | 196.6 MB | `0.28.6` |
| OpenCode | `opencode-ai` | 1.19.6 | 609.5 MB | `1.19.6` |
| Copilot CLI | `@github/copilot` | 1.0.116 | 195.1 MB | `GitHub Copilot CLI 1.0.116.` |
| Cline | `cline` | 3.0.76 | 309.5 MB | `3.0.76` |

Disk sizes are the recursive size of each package directory (hard links in the
npm cache are counted again, so this is an upper bound on added disk).

## What the no-credential attempt produced

All seven CLIs refuse before a model call. Five emit machine-readable events
while refusing, which is what makes these files useful to the parser.

| agent | command | result |
|---|---|---|
| Claude Code | `claude -p "Reply with OK" --output-format stream-json --verbose` | exit 1. Real stream-json: `system:init` with the tool inventory, one assistant turn carrying `error: oauth_org_not_allowed` (403, `total_cost_usd: 0`), then a `result` envelope with `is_error: true`. The org has disabled Claude subscription access for Claude Code. |
| Codex | `codex exec --json --skip-git-repo-check "Reply with OK"` | exit 1 after 24 s. JSONL: `thread.started`, `turn.started`, then `error` events with `401 Unauthorized: Missing bearer or basic authentication`, then `turn.failed`. Empty `CODEX_HOME` means no stored token. |
| Gemini CLI | `gemini -p "Reply with OK" -o stream-json` | exit 41, no JSON on stdout. stderr: `Please set an Auth method ... GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA`. |
| Qwen Code | `qwen -p "Reply with OK" -o stream-json` | exit 1. One JSON `result` event: `error_during_execution`, `No auth type is selected`. |
| OpenCode | `opencode run --format json "Reply with OK"` | exit 1. One JSON `error` event: 401 `Authentication error` from its configured provider endpoint. |
| Copilot CLI | `copilot -p "Reply with OK" --output-format json` | exit 1. One JSON `result` event with `exitCode: 1`; stderr says the stored token could not be validated (`Failed to fetch GitHub CLI user login`). |
| Cline | `cline --json "Reply with OK"` | exit 1, nothing on stdout. stderr JSON: `{"type":"error","message":"Token refresh failed: 503"}`. |

No API key was supplied and no stored account was used for a model call. The
only request that reached a provider was Claude's, which the provider rejected
with the org-level 403 at zero cost.

## Parse test

`daemon/test/transcripts.test.mjs` runs the existing `StreamJsonParser`
(`daemon/src/stream_json_parser.js`) over all 21 files and checks:

- the parser never throws and returns exactly one item per JSON line, in order,
  with each item's `raw` equal to the source event;
- the `--version` and `--help` files, and Gemini's plain-text refusal, yield
  zero items rather than an error;
- the first stdout line of every `version.txt` carries the manifest version;
- Claude's file yields the `system_init` / `assistant_text` / `result` turn
  sequence and the init event names the tool inventory;
- Codex's file carries `thread.started`, `turn.started` and `turn.failed`;
- no file ends with a tool call left pending, and every method that carries a
  `session_id` keeps it on the parsed item.

Run it directly with `node daemon/test/transcripts.test.mjs`, or as part of
`cd daemon && npm test`.

## Limits

- Every CLI here is credential-gated for an actual conversation. These files
  prove version, surface and refusal shape; they do not contain a successful
  assistant turn, and none contains a `tool_use` block. Tool-call pairing is
  covered by the synthetic fixtures in `stream-tool-correlation.test.mjs`,
  not by a captured success.
- Codex and Gemini do not emit their stream format on the refusal path (Codex
  does, Gemini does not), so those two are text-only captures plus Codex's
  error JSONL.
- Copilot's failure is a token validation error over the network, and Cline's
  is a provider `503`; neither is proof that a valid key would be accepted by
  this build, only that this machine has no working credential.
- Captures are from Windows. Line endings and ANSI behaviour on macOS/Linux are
  not represented.
