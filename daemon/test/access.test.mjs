// Connection password and the control gate, checked without a display: the daemon rejects a
// correct token that lacks the password, and the local /access endpoint needs the token.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { REPO, check, connect, finish, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8824;
const CLI_PORT = 46824;
const TOKEN = "accesstoken";
const home = path.join(os.tmpdir(), "rh-home-" + PORT);
fs.rmSync(home, { recursive: true, force: true });

const base = `http://127.0.0.1:${PORT}`;
const status = () => fetch(`${base}/access?k=${TOKEN}`).then((r) => r.json());
const post = (p, body) =>
  fetch(`${base}${p}?k=${TOKEN}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
/** Resolve { welcome } on a completed handshake, or { code } on the close that refused it. */
const attempt = (password, token = TOKEN) =>
  new Promise((resolve) => {
    const c = connect(PORT, token);
    c.ws.on("open", () => c.send({ type: "hello", token, ...(password ? { password } : {}) }));
    c.ws.on("close", (code) => resolve({ code }));
    c.next((m) => m.type === "welcome", 8000)
      .then(() => resolve({ welcome: true }))
      .catch(() => {});
  });

const policyFile = path.join(home, "policy.json");
const d = startDaemon(PORT, CLI_PORT, {
  token: TOKEN,
  env: {
    RH_POLICY_JSON: policyFile,
    RH_POLICY_REG: `HKCU\\SOFTWARE\\PocketDesk\\PolicyAccessTest-${process.pid}`,
  },
});
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
  check(
    "paused control refuses a file write",
    refused.type === "error" && /paused/.test(refused.message) && !fs.existsSync(target),
  );
  paused.send({ type: "fs" });
  check(
    "paused control still lists files",
    !(await paused.next((m) => m.type === "fs" || m.type === "error", 8000)).error,
  );
  await paused.close();
  await post("/access/control", { allowed: true });
  check("control toggle restores", (await status()).controlAllowed === true);

  await post("/access/password", { password: "s3cret-pass" });
  check("password now set", (await status()).hasPassword === true);
  check("right token, no password is refused", (await attempt()).code === 4012);
  check("right token, wrong password is refused", (await attempt("nope")).code === 4012);
  // Without the token, the close code must not reveal whether a guessed password was right.
  check(
    "wrong token, wrong password reads as bad token",
    (await attempt("nope", "wrongtoken1")).code === 4003,
  );
  check("right token and password connects", (await attempt("s3cret-pass")).welcome === true);
  await post("/access/password", { password: "" });
  check("password cleared", (await status()).hasPassword === false);

  await post("/access/record", { on: true });
  check("recording toggle turns on", (await status()).recording === true);
  await post("/access/record", { on: false });
  check("recording toggle turns off", (await status()).recording === false);

  // A proposal is created from the phone, reaches every authed socket, and an approval that names
  // nothing real answers with that name instead of a silent success.
  const proposer = await openAndHello(PORT, TOKEN);
  proposer.send({
    type: "propose",
    proposalType: "command_execute",
    summary: "restart the service",
    sessionId: "s1",
  });
  const created = await proposer.next((m) => m.type === "proposal_created", 8000);
  check(
    "propose broadcasts the proposal with its summary and type",
    created.proposal?.summary === "restart the service" && created.proposal?.type === "command_execute",
  );
  proposer.send({ type: "approve", id: "no-such-proposal" });
  const unknownApproval = await proposer.next((m) => m.type === "error", 8000);
  check(
    "approving an unknown proposal answers with its id",
    /no-such-proposal/.test(unknownApproval.message),
  );
  await proposer.close();

  const early = await new Promise((resolve) => {
    const c = connect(PORT, TOKEN);
    c.ws.on("open", () => c.send({ type: "sessions" }));
    c.ws.on("close", (code) => resolve(code));
  });
  check("a message before hello closes the socket", early === 4003);

  const code = await fetch(`${base}/access`)
    .then((r) => r.status)
    .catch(() => 0);
  check("/access without the token is forbidden", code === 403);

  // A socket that is not watching the desktop cannot drive it: a stopped or never-started
  // stream leaves no control behind. This is the refusal path, so it needs no display.
  const idle = await openAndHello(PORT, TOKEN);
  idle.send({ type: "desktop_key", key: 65 });
  const r = await idle.next((m) => m.type === "desktop_input_ok", 8000);
  check("input without an open desktop is refused", r.ok === false && r.error === "view only");
  await idle.close();

  // ?? Machine-owner policy: a 0 in either store refuses the sense before anything starts ??
  const writePolicy = (v) => fs.writeFileSync(policyFile, JSON.stringify(v));
  const settlePolicy = () => new Promise((r) => setTimeout(r, 1200));
  const logLines = () => {
    const dir = path.join(home, "logs");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("daemon-")) : [];
    return files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean));
  };
  const refusedBy = (m, key) =>
    m.type === "error" &&
    m.code === "disabled_by_policy" &&
    m.key === key &&
    new RegExp("disabled_by_policy: " + key).test(m.message);
  const gate = await openAndHello(PORT, TOKEN);
  const senses = [
    {
      key: "AllowRemoteControl",
      msg: { type: "desktop_start" },
      ok: (m) => m.type === "desktop_started" && m.ok === true,
    },
    { key: "AllowWebcam", msg: { type: "adb_webcam", on: false }, ok: (m) => m.type === "adb_webcam" },
    {
      key: "AllowPhoneControl",
      msg: { type: "phone_fs", rid: 7, op: "ls", path: "/" },
      ok: (m) => m.type === "phone_fs_result",
    },
    { key: "AllowClipboard", msg: { type: "clipboard_get" }, ok: (m) => m.type === "clipboard" },
  ];
  for (const sense of senses) {
    writePolicy({ [sense.key]: 0 });
    await settlePolicy();
    gate.send(sense.msg);
    const off = await gate.next((m) => m.type === "error" || sense.ok(m), 15000);
    check(`${sense.key} set to 0 refuses its sense`, refusedBy(off, sense.key));
    if (sense.key === "AllowRemoteControl") {
      gate.send({ type: "running_state" });
      const st = await gate.next((m) => m.type === "running_state", 8000);
      check(
        "the refused desktop_start started no stream",
        st.streams.video === 0 && st.streams.desktop === 0,
      );
    }
    writePolicy({});
    await settlePolicy();
    gate.send(sense.msg);
    const on = await gate.next(sense.ok, 30000);
    check(`${sense.key} back on lets the sense run`, sense.ok(on));
    if (sense.key === "AllowRemoteControl") {
      gate.send({ type: "desktop_stop" });
      await gate.next((m) => m.type === "desktop_stopped", 10000);
    }
  }
  const refusedLines = logLines().filter((l) => l.includes('"event":"refused"'));
  check(
    "each refusal is in the daemon log with its key",
    senses.every((sense) => refusedLines.some((l) => l.includes(sense.key))),
  );
  await gate.close();

  // Three guards on every local settings route at once: the peer is loopback, the Host header is a
  // loopback name (DNS rebinding arrives from 127.0.0.1 under an attacker's name), and the key is the
  // pairing token. The route list is read from server.js so a new /access route cannot ship unguarded.
  const src = fs.readFileSync(path.join(REPO, "daemon", "src", "server.js"), "utf8");
  const routes = [...new Set([...src.matchAll(/path0 === "(\/access[^"]*)"/g)].map((m) => m[1]))];
  check(
    "the /access route list comes from server.js",
    routes.length >= 13 && routes.includes("/access/totp/setup"),
  );
  const probe = (target, host) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: target,
          method: "GET",
          headers: { host: host || `127.0.0.1:${PORT}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const unguarded = [];
  for (const r of routes) {
    if ((await probe(r)) !== 403) unguarded.push("no key: " + r);
    if ((await probe(r + "?k=not-the-token")) !== 403) unguarded.push("wrong key: " + r);
    if ((await probe(r + "?k=" + TOKEN, `evil.example:${PORT}`)) !== 403)
      unguarded.push("non-loopback Host: " + r);
  }
  check(
    "every /access route is 403 without the key, with a wrong key and under a non-loopback Host",
    unguarded.length === 0 && routes.length >= 13,
  );
  check("/access with the key and a loopback Host answers", (await probe(`/access?k=${TOKEN}`)) === 200);
  check("/pair is 403 without the key", (await probe("/pair")) === 403);
  check(
    "/pair is 403 under a non-loopback Host even with the key",
    (await probe(`/pair?k=${TOKEN}`, `evil.example:${PORT}`)) === 403,
  );
  check("/pair redirects the PC own browser to the hub", (await probe(`/pair?k=${TOKEN}`)) === 302);
} finally {
  await teardown(home);
}
finish();
