import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
// Digest render absorption test — exercises the `render_digest` protocol
// surface (restty inspiration: read-only plain-text digest render for token
// savings). ANSI escape sequences are stripped to a plain text grid; trailing
// blank rows are trimmed off the wire.
import { TerminalRenderer } from "../src/terminal_renderer.js";

const tmp = makeTmp("rh-digest-");

const PORT = 8804;
const CLI_PORT = 46804;
const TOKEN = "digesttoken";

async function main() {
  // ── Unit: the renderer itself ─────────────────────────────────────────────
  const r = new TerminalRenderer({ cols: 20, rows: 5 });
  r.feed("\x1b[31mred text\x1b[0m\nsecond line");
  const screen = r.getScreen();
  check("renderer strips ANSI colors", screen[0]?.includes("red text") && !screen[0]?.includes("\x1b"));
  check("renderer tracks rows", screen[1]?.includes("second line"));
  check("stringWidth counts CJK as 2", (await import("../src/terminal_renderer.js")).stringWidth("中文a") === 5);

  // ── Protocol: render_digest over WS ───────────────────────────────────────
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({
    type: "render_digest",
    cols: 40,
    text: "\x1b[1mbold title\x1b[0m\nplain body\n\n\n",
  });
  const rendered = await c.next((m) => m.type === "digest_render");
  check("digest_render returns plain rows", rendered.rows[0] === "bold title" && rendered.rows[1] === "plain body");
  check("digest_render trims trailing blank rows", rendered.rows.length === 2);
  check("digest_render reports width", rendered.width === 40);

  // Empty input → empty rows, no crash.
  c.send({ type: "render_digest", text: "" });
  const empty = await c.next((m) => m.type === "digest_render" && m.rows.length === 0);
  check("digest_render handles empty text", !!empty);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });