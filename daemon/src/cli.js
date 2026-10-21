// pocketdesk list | new [--cwd DIR] [tool] | attach ID | send ID KEYS... | read ID | resize ID COLS ROWS | kill ID
// Talks to the daemon on 127.0.0.1; the terminals are the same ones the phone and the browser watch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.RH_CLI_PORT) || 4679;
const home = process.env.RH_HOME || path.join(os.homedir(), ".pocketdesk");
const token = process.env.RH_TOKEN || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).token; } catch { return ""; }
})();

async function call(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body),
  }).catch(() => fail(`PocketDesk is not running on this PC (no answer on port ${port})`));
  if (!r.ok) fail((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r;
}

function fail(msg) {
  console.error(`pocketdesk: ${msg}`);
  process.exit(1);
}

// tmux send-keys names; any other argument is typed as is.
const KEYS = {
  Enter: "\r", Tab: "\t", Escape: "\x1b", Esc: "\x1b", BSpace: "\x7f", Space: " ",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D", Home: "\x1b[H", End: "\x1b[F",
  PageUp: "\x1b[5~", PageDown: "\x1b[6~", PgUp: "\x1b[5~", PgDn: "\x1b[6~", Delete: "\x1b[3~", DC: "\x1b[3~",
};
function keys(args) {
  return args.map((a) => KEYS[a] ?? (/^C-[a-zA-Z@\[\]\\^_]$/.test(a) ? String.fromCharCode(a[2].toUpperCase().charCodeAt(0) & 31) : a)).join("");
}

const [cmd, id, ...rest] = process.argv.slice(2);
const need = (v, what) => v || fail(`${cmd}: missing ${what}`);

if (cmd === "list") {
  for (const s of await (await call("GET", "/term")).json()) console.log(`${s.id}\t${s.harnessId}\t${s.cols}x${s.rows}\t${s.cwd}`);
} else if (cmd === "new") {
  const args = process.argv.slice(3);
  const at = args.indexOf("--cwd");
  const cwd = at >= 0 ? args.splice(at, 2)[1] : process.cwd();
  console.log((await (await call("POST", "/term", { harness: args[0] || "shell", cwd })).json()).id);
} else if (cmd === "send") {
  await call("POST", `/term/${need(id, "terminal id")}/in`, { data: keys(rest) });
} else if (cmd === "read") {
  process.stdout.write(await (await call("GET", `/term/${need(id, "terminal id")}/screen`)).text());
} else if (cmd === "resize") {
  await call("POST", `/term/${need(id, "terminal id")}/resize`, { cols: Number(rest[0]), rows: Number(rest[1]) });
} else if (cmd === "kill") {
  await call("POST", `/term/${need(id, "terminal id")}/kill`);
} else if (cmd === "attach") {
  need(id, "terminal id");
  if (!process.stdin.isTTY) fail("attach needs a terminal; use send and read from scripts");
  // This window is the PC side, so the terminal takes its size.
  const size = () => call("POST", `/term/${id}/resize`, { cols: process.stdout.columns, rows: process.stdout.rows });
  await size();
  process.stdout.on("resize", size);
  const stream = (await call("GET", `/term/${id}/stream`)).body;
  process.stdin.setRawMode(true);
  // Ctrl+] leaves the terminal running, as telnet's escape does. PowerShell turns on win32-input-mode,
  // after which keys arrive as ESC[Vk;Sc;Char;Down;Ctrl;Repeat_ and Ctrl+] is char 29.
  const DETACH = /\x1d|\x1b\[\d*;\d*;29;1;\d*;\d*_/;
  process.stdin.on("data", (d) => {
    const m = DETACH.exec(d.toString("latin1"));
    if (!m) return call("POST", `/term/${id}/in`, { data: d.toString() });
    if (m.index > 0) call("POST", `/term/${id}/in`, { data: d.subarray(0, m.index).toString() });
    done("detached");
  });
  // Modes the shell switched on in this window (win32 input, focus reports) must not outlive it.
  const done = (why) => { process.stdin.setRawMode(false); process.stdout.write(`\x1b[?9001l\x1b[?1004l\r\n[pocketdesk: ${why}]\r\n`); process.exit(0); };
  process.stdout.write("\x1b[2J\x1b[H");
  for await (const chunk of stream) process.stdout.write(chunk);
  done("terminal ended");
} else {
  fail(`unknown command: ${cmd}`);
}
