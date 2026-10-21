// One terminal shared by a phone, the PC and the local CLI: the CLI drives it, every viewer sees it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, connect, finish, makeTmp, REPO, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8873;
const CLI_PORT = 46873;
const TOKEN = "termtoken";
const tmp = makeTmp("rh-term-");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = path.join(os.tmpdir(), "rh-home-" + PORT);

/** Runs `pocketdesk <args>` against the test daemon; resolves stdout. */
function cli(...args) {
  return new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, "daemon", "src", "index.js"), ...args],
    { env: { ...process.env, RH_CLI_PORT: String(CLI_PORT), RH_TOKEN: TOKEN, RH_HOME: HOME }, timeout: 15000 },
    (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));
}

async function screenHas(id, text, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(300)) {
    const s = await cli("read", id);
    if (s.includes(text)) return s;
  }
  return "";
}

try {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  // Pairing from a bare TTY: the QR is drawn in the terminal, with the link for when it does not fit.
  const pair = await cli("pair");
  check("pair prints the link and a terminal QR", /pocketdesk:\/\/pair#[\w-]+/.test(pair) && /[█▀▄]{8}/.test(pair));
  await cli("record", "on");
  const flag = path.join(HOME, "record-sessions");
  const on = fs.existsSync(flag);
  await cli("record", "off");
  check("record on/off flips the recording flag", on && !fs.existsSync(flag));
  const phone = connect(PORT, TOKEN);
  await new Promise((res, rej) => { phone.ws.on("open", res); phone.ws.on("error", rej); });
  phone.send({ type: "hello", token: TOKEN, platform: "android", name: "test phone" });
  await phone.next((m) => m.type === "welcome");

  const id = (await cli("new", "--cwd", tmp)).trim();
  check("new prints the session id", /^s\d+$/.test(id));
  check("list shows the shared shell", (await cli("list")).includes(id));

  phone.send({ type: "attach", id });
  const replay = await phone.next((m) => m.type === "replay" && m.id === id);
  check("a viewer learns the terminal size from the replay", replay.cols > 0 && replay.rows > 0);

  await cli("send", id, "echo pocket-$(40+2)", "Enter");
  const screen = await screenHas(id, "pocket-42");
  check("send types into the shell and read shows the rendered screen", screen.includes("pocket-42"));
  const seen = await phone.next((m) => m.type === "out" && m.id === id && Buffer.from(m.data, "base64").toString().includes("pocket-42"));
  check("the phone watching the same terminal sees the output", !!seen);

  await cli("resize", id, "90", "25");
  const size = await phone.next((m) => m.type === "size" && m.id === id);
  check("a PC-side resize reaches every viewer", size.cols === 90 && size.rows === 25);
  phone.send({ type: "resize", id, cols: 30, rows: 10 });
  await wait(500);
  check("the phone cannot resize: the terminal keeps the PC size", (await cli("list")).includes("90x25"));

  await cli("kill", id);
  check("kill ends it", !!(await phone.next((m) => m.type === "exit" && m.id === id)));
  await phone.close();
} catch (e) {
  check("shared terminal flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
