// Connection password and the control gate, checked without a display: the daemon rejects a
// correct token that lacks the password, and the local /access endpoint needs the token.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { check, connect, finish, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8824;
const CLI_PORT = 46824;
const TOKEN = "accesstoken";
const home = path.join(os.tmpdir(), "rh-home-" + PORT);
fs.rmSync(home, { recursive: true, force: true });

const base = `http://127.0.0.1:${PORT}`;
const status = () => fetch(`${base}/access?k=${TOKEN}`).then((r) => r.json());
const post = (p, body) => fetch(`${base}${p}?k=${TOKEN}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
/** Resolve { welcome } on a completed handshake, or { code } on the close that refused it. */
const attempt = (password, token = TOKEN) => new Promise((resolve) => {
  const c = connect(PORT, token);
  c.ws.on("open", () => c.send({ type: "hello", token, ...(password ? { password } : {}) }));
  c.ws.on("close", (code) => resolve({ code }));
  c.next((m) => m.type === "welcome", 8000).then(() => resolve({ welcome: true })).catch(() => {});
});

const d = startDaemon(PORT, CLI_PORT, { token: TOKEN });
await d.ready;
try {
  const own = await openAndHello(PORT, TOKEN);
  check("connects with no password set", true);
  await own.close();

  const s0 = await status();
  check("status starts open", s0.controlAllowed === true && s0.hasPassword === false);

  await post("/access/control", { allowed: false });
  check("control toggle persists", (await status()).controlAllowed === false);
  // Paused control leaves the phone able to look but not act, through any handler, not only the desktop.
  const paused = await openAndHello(PORT, TOKEN);
  const target = path.join(os.tmpdir(), `rh-paused-${PORT}.txt`);
  fs.rmSync(target, { force: true });
  paused.send({ type: "fwrite", path: target, data: "aGk=" });
  const refused = await paused.next((m) => m.type === "error" || m.type === "fwritten", 8000);
  check("paused control refuses a file write", refused.type === "error" && /paused/.test(refused.message) && !fs.existsSync(target));
  paused.send({ type: "fs" });
  check("paused control still lists files", !(await paused.next((m) => m.type === "fs" || m.type === "error", 8000)).error);
  await paused.close();
  await post("/access/control", { allowed: true });
  check("control toggle restores", (await status()).controlAllowed === true);

  await post("/access/password", { password: "s3cret-pass" });
  check("password now set", (await status()).hasPassword === true);
  check("right token, no password is refused", (await attempt()).code === 4012);
  check("right token, wrong password is refused", (await attempt("nope")).code === 4012);
  // Without the token, the close code must not reveal whether a guessed password was right.
  check("wrong token, wrong password reads as bad token", (await attempt("nope", "wrongtoken1")).code === 4003);
  check("right token and password connects", (await attempt("s3cret-pass")).welcome === true);
  await post("/access/password", { password: "" });
  check("password cleared", (await status()).hasPassword === false);

  await post("/access/record", { on: true });
  check("recording toggle turns on", (await status()).recording === true);
  await post("/access/record", { on: false });
  check("recording toggle turns off", (await status()).recording === false);

  const early = await new Promise((resolve) => {
    const c = connect(PORT, TOKEN);
    c.ws.on("open", () => c.send({ type: "sessions" }));
    c.ws.on("close", (code) => resolve(code));
  });
  check("a message before hello closes the socket", early === 4003);

  const code = await fetch(`${base}/access`).then((r) => r.status).catch(() => 0);
  check("/access without the token is forbidden", code === 403);

  // A socket that is not watching the desktop cannot drive it: a stopped or never-started
  // stream leaves no control behind. This is the refusal path, so it needs no display.
  const idle = await openAndHello(PORT, TOKEN);
  idle.send({ type: "desktop_key", key: 65 });
  const r = await idle.next((m) => m.type === "desktop_input_ok", 8000);
  check("input without an open desktop is refused", r.ok === false && r.error === "view only");
  await idle.close();
} finally {
  await teardown(home);
}
finish();
