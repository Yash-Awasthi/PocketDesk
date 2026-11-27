# Qwen Code transcripts

Three files here follow the repo-wide capture convention and were produced with no
credentials, so each one ends in a refusal:

- `version.txt` - `qwen --version`
- `help.txt` - `qwen --help`
- `print.txt` - `qwen -p "Reply with OK" -o stream-json`, refused with
  `error_during_execution` because no auth type was selected

`real-turn.jsonl` is different: it is one real provider turn, captured 2026-11-26
through a Groq key that was set in the environment. It holds a real `thinking` block,
a real `tool_use` (`glob {"pattern":"*.md"}`), its `tool_result`, then a genuine
upstream failure: Groq rejects the `reasoning_content` field qwen echoes back on the
second turn, so the run ends with `error_during_execution`. The failure is kept as
captured; no successful multi-turn is implied.

No key value is stored in this repository. The provider key was supplied as the
user-scope environment variable `GROQ_API_KEY` and passed to the CLI as
`OPENAI_API_KEY`; only the base URL and the model name are recorded in the header.

Evidence, including the exact commands and the minimal request accounting:
`C:\GITHUB\.fleet\evidence\PocketDesk\groq-capture\` (`README.md` and the raw
`qwen-tool-turn.jsonl`). This file is a copy of that raw capture with the BOM
stripped, every JSON line kept, and the `#` header added.

The daemon's existing `StreamJsonParser` parses it; `daemon/test/transcripts.test.mjs`
asserts the tool name and input, the tool result, the thinking block, the single
assistant turn and the failing result.
