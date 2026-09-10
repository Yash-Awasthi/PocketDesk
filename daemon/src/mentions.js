/**
 * Mentions — @file mention expansion in prompts.
 *
 * Absorbed from hermes-android / mobvibe / agent-tmux-web (attach context into
 * the prompt by mentioning it): before a prompt reaches the agent, every
 * @path token that resolves to an existing plain file on the PC is replaced by
 * an inlined fenced block with the file's content, so the phone can reference
 * PC-side files without uploading them.
 *
 * Security: only plain files are read; size is capped per mention and in
 * total; unmatched tokens pass through untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PER_MENTION = 64 * 1024;
const MAX_TOTAL = 256 * 1024;
const MAX_MENTIONS = 16;

const MENTION_RE = /(?:^|\s)@((?:[A-Za-z]:)?[^\s@]+)/g;

function expandToken(raw) {
  let p = raw.replace(/^"|"$/g, "");
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Expand @mentions in `text`. cwd anchors relative paths (defaults to home).
 * Returns { text: expanded, mentions: [{ token, path, ok, bytes }] }.
 */
export function expand(text, cwd) {
  const base = cwd && String(cwd).trim() ? path.resolve(String(cwd)) : os.homedir();
  const found = [...String(text ?? "").matchAll(MENTION_RE)].map((m) => m[1]).slice(0, MAX_MENTIONS);
  if (!found.length) return { text: String(text ?? ""), mentions: [] };

  let total = 0;
  const mentions = [];
  let out = String(text);
  for (const token of found) {
    let abs = expandToken(token);
    if (!path.isAbsolute(token)) abs = path.resolve(base, token);
    let entry = { token, path: abs, ok: false, bytes: 0 };
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_PER_MENTION && total + Math.min(st.size, MAX_PER_MENTION) <= MAX_TOTAL) {
        const content = fs.readFileSync(abs, "utf8");
        out = out.replace(`@${token}`, `@${token}\n\`\`\`\n${content}\n\`\`\``);
        entry.ok = true;
        entry.bytes = content.length;
        total += content.length;
      } else if (st.isFile()) {
        entry.error = st.size > MAX_PER_MENTION ? `file too large (${st.size} > ${MAX_PER_MENTION})` : "mention budget exceeded";
      } else {
        entry.error = "not a plain file";
      }
    } catch {
      entry.error = "not found";
    }
    mentions.push(entry);
  }
  return { text: out, mentions };
}
