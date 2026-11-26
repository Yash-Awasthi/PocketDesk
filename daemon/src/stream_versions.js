// Per-agent stream fixtures are pinned to the CLI version they target, so a newer CLI
// is reported at chat start instead of being parsed as if nothing changed.
import { parseVersion } from "./registry.js";

export const FIXTURE_VERSIONS = {
  "claude-stream-json": "2.0.14",
  "codex-json": "0.55.0",
  "gemini-json": "0.17.0",
  "copilot-json": "0.0.354",
  "cline-json": "3.0.0",
  "opencode-json": "1.0.0",
  text: "0.11.0",
};

const major = (parts) => parts[0];

/** Compares the version a fixture set targets with the installed CLI's version. */
export function streamVersionStatus(format, installed) {
  const fixture = FIXTURE_VERSIONS[format] ?? null;
  const base = { format, fixture, installed: installed ?? null };
  const raw = installed == null ? "" : String(installed).trim();
  if (!fixture || !raw) return { ...base, level: "none", ok: true, message: "" };
  const parsed = parseVersion(raw);
  if (!parsed)
    return {
      ...base,
      level: "unknown",
      ok: false,
      message: `[stream] ${format}: fixture ${fixture}, installed "${raw}" is not an x.y.z version`,
    };
  const got = parsed.parts;
  const want = fixture.split(".").map(Number);
  const named = { ...base, installed: parsed.version };
  if (major(got) !== major(want))
    return {
      ...named,
      level: "refuse",
      ok: false,
      message: `[stream] ${format}: fixture ${fixture}, installed ${parsed.version}; the parser is not trusted for this major`,
    };
  if (got[1] !== want[1] || got[2] !== want[2])
    return {
      ...named,
      level: "warn",
      ok: false,
      message: `[stream] ${format}: fixture ${fixture}, installed ${parsed.version}; minor drift may mis-parse`,
    };
  return { ...named, level: "ok", ok: true, message: "" };
}
