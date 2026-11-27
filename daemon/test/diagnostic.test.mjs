// The support bundle: redaction by key and by value, the log tail, and a live daemon handing back
// a bundle that names no credential — the one property a bundle must never lose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import { bundle, knownSecrets, logTail, redact } from "../src/diagnostic.js";
import { PROTOCOL_VERSION } from "../src/running.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TOKEN = "diag-bundle-token-0123456789";
const PW = "hunter2hunter2";

// ── redaction: by key, then by value ──
const dropped = redact({
  token: TOKEN,
  nested: { tls: { privateKey: PW, cert: "/home/u/.pocketdesk/tls/cert.pem" } },
  policy: { totp: true, password: PW, remote: false },
});
check("a token key is dropped at the top", !("token" in dropped));
check("a private key is dropped deep in the tree", !("privateKey" in dropped.nested.tls));
check("a harmless sibling survives", dropped.nested.tls.cert.endsWith("cert.pem"));
check("the totp key is kept", dropped.policy.totp === true);
check("a password key is dropped, not merely emptied", !("password" in dropped.policy));

const scrubbed = redact({ logs: [{ name: "daemon.log", text: `login token=${TOKEN} password=${PW}` }] }, [
  TOKEN,
  PW,
]);
check(
  "a token inside a log line is replaced",
  !scrubbed.logs[0].text.includes(TOKEN) && scrubbed.logs[0].text.includes("[redacted]"),
);
check("a password inside a log line is replaced", !scrubbed.logs[0].text.includes(PW));
const arr = redact([`a ${TOKEN}`, `b ${PW}`], [TOKEN, PW]);
check("secrets inside an array are scrubbed", !arr.join(" ").includes(TOKEN) && !arr.join(" ").includes(PW));
check(
  "numbers, booleans and null pass through",
  redact({ n: 3, b: false, z: null }).n === 3 &&
    redact({ b: false }).b === false &&
    redact({ z: null }).z === null,
);
check("a huge string is capped at 64 KiB", redact("x".repeat(100_000)).length === 64 * 1024);

// ── knownSecrets: the config's credentials, not its paths ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-diag-"));
const cfgPath = path.join(home, "config.json");
fs.writeFileSync(
  cfgPath,
  JSON.stringify({
    port: 8952,
    token: TOKEN,
    connPassword: "scrypt-record-abcdefgh",
    tls: { enabled: true, cert: "/home/u/.pocketdesk/tls/cert.pem", key: "/home/u/.pocketdesk/tls/key.pem" },
    notes: { password: PW, ticket: "short" },
  }),
);
const secrets = knownSecrets(cfgPath);
check("the config token is a known secret", secrets.includes(TOKEN));
check("a nested password is a known secret", secrets.includes(PW));
check("the tls cert path is not a secret", !secrets.join("|").includes("cert.pem"));
check("the tls key path is not a secret", !secrets.join("|").includes("key.pem"));
check("a short value under a secret key is not a secret", !secrets.includes("short"));
check("a missing config yields no secrets", knownSecrets(path.join(home, "nope.json")).length === 0);

// ── logTail: the last bytes, and nothing that is missing ──
fs.writeFileSync(path.join(home, "big.log"), "a".repeat(50_000) + "TAILEND");
const tail = logTail(home, ["big.log", "missing.log"], 1000);
check("only the existing log is tailed", tail.length === 1 && tail[0].name === "big.log");
check("only the last bytes are kept", tail[0].text.length <= 1000 && tail[0].text.endsWith("TAILEND"));
check("a folder with no logs yields nothing", logTail(home).length === 0);

// ── bundle: shape, plus the guarantee ──
const built = bundle({
  ports: { daemon: "8952", page: 8962, cli: "46952", usb: undefined },
  sessions: [{ id: "0123456789abcdef", harnessId: "node", kind: "terminal", state: "running" }],
  policy: { control: true, remote: false, password: true, totp: true, recording: false },
  status: [`running: yes`, `token=${TOKEN}`],
  logs: [{ name: "daemon.log", text: `token=${TOKEN} password=${PW}` }],
  secrets: [TOKEN, PW],
  platform: "win32",
  arch: "x64",
  version: "9.9.9",
  now: 0,
});
check(
  "the bundle has app, runtime, ports, sessions, policy and status",
  Boolean(
    built.app &&
    built.runtime &&
    built.ports &&
    built.sessions &&
    built.policy &&
    Array.isArray(built.status),
  ),
);
check(
  "the bundle names the app and the protocol",
  built.app.name === "pocketdesk" && built.app.version === "9.9.9" && built.app.protocol === PROTOCOL_VERSION,
);
check(
  "bundle ports are numbers, never NaN",
  built.ports.daemon === 8952 && built.ports.cli === 46952 && built.ports.usb === 0,
);
check(
  "the session id is shortened to eight characters",
  built.sessions.count === 1 && built.sessions.items[0].id === "01234567",
);
check(
  "the policy flags are booleans",
  built.policy.control === true && built.policy.totp === true && built.policy.recording === false,
);
check("the time is ISO", built.at === "1970-01-01T00:00:00.000Z");
check(
  "no supplied secret survives the bundle",
  !JSON.stringify(built).includes(TOKEN) && !JSON.stringify(built).includes(PW),
);
check(
  "the status line that carried a token is scrubbed",
  built.status.every((l) => !l.includes(TOKEN)),
);

// ── the live half: a real daemon, a real log, a real socket ──
const tmp = makeTmp("rh-diag-");
const PORT = 8952;
const CLI_PORT = 46952;
const liveHome = path.join(tmp, "home");
fs.mkdirSync(liveHome, { recursive: true });
// The daemon reads its token from RH_TOKEN, so the copy on disk is what knownSecrets finds.
fs.writeFileSync(
  path.join(liveHome, "config.json"),
  JSON.stringify({ port: PORT, token: TOKEN, notes: { password: PW } }),
);
fs.writeFileSync(
  path.join(liveHome, "daemon.log"),
  ["listening on " + PORT, `pair token=${TOKEN}`, `password=${PW}`].join("\n") + "\n",
);
const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, home: liveHome });
await d.ready;
try {
  const c = await openAndHello(PORT, TOKEN);
  c.send({ type: "diagnostic_bundle" });
  const m = await c.next((x) => x.type === "diagnostic_bundle");
  const text = JSON.stringify(m);
  check("the live bundle names the daemon version", m.app.version === pkg.version);
  check("the live daemon and CLI ports are reported", m.ports.daemon === PORT && m.ports.cli === CLI_PORT);
  check(
    "the status lines ride along",
    Array.isArray(m.status) && m.status.some((l) => l.startsWith("running:")),
  );
  check("the daemon log rides along", Array.isArray(m.logs) && m.logs.some((l) => l.name === "daemon.log"));
  check("no token value leaves the machine", !text.includes(TOKEN));
  check("no password value leaves the machine", !text.includes(PW));
  check("no token key leaves the machine", !/"token"\s*:/.test(text));
  await c.close();
} catch (e) {
  check("diagnostic flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
