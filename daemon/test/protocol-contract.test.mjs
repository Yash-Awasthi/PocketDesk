// The protocol contract, as a test.
//
// Every message the daemon answers is documented in daemon/README.md from the handler registry
// (`scripts/gen-protocol-doc.mjs`, checked by test/protocol-doc.test.mjs). This file covers the
// rest of the contract, without a phone in hand:
//
//   1. every type the app sends has a daemon handler, and every type it handles is sent;
//   2. every documented message names a handler file that exists and declares it;
//   3. every documented message is exercised by at least one test, kept honest by
//      protocol-untested.txt, which may only shrink: a new message with no test fails, and a
//      message that gains a test must be deleted from the list in the same commit;
//   4. an unknown message type is refused with the documented error, against a real daemon.
import fs from "node:fs";
import path from "node:path";
import {
  REPO,
  check,
  finish,
  makeTmp,
  openAndHello,
  startDaemon,
  teardown,
  waitForHealth,
} from "./helpers.mjs";
import agentsHandlers from "../src/handlers/agents.js";
import filesHandlers from "../src/handlers/files.js";
import remoteHandlers from "../src/handlers/remote.js";
import sshHandlers from "../src/handlers/ssh.js";
import systemHandlers from "../src/handlers/system.js";
import phoneHandlers from "../src/handlers/phone.js";
import { withSources } from "../src/handlers/sources.js";
import { PROTOCOL_VERSION } from "../src/version.js";

const APP = path.join(REPO, "app", "app", "src", "main", "java", "com", "yasha", "pocketdesk");
const DAEMON = path.join(REPO, "daemon", "src");

function walk(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
}

// The app side: every type it sends must have a handler, every type it handles must be sent.
const handled = new Set(["hello"]);
for (const make of [agentsHandlers, filesHandlers, remoteHandlers, sshHandlers, systemHandlers, phoneHandlers]) {
  for (const k of Object.keys(make({}))) handled.add(k);
}
for (const k of Object.keys(withSources({}, {}))) handled.add(k);

const protocol = fs.readFileSync(path.join(APP, "Protocol.kt"), "utf8");
const sent = new Set([...protocol.matchAll(/put\("type", "([a-z_]+)"\)/g)].map((m) => m[1]));
// serverStart/Stop/Stats build the type from a kind; the app passes these two.
for (const kind of ["bastion", "sshserver"]) for (const op of ["start", "stop", "stats"]) sent.add(`${kind}_${op}`);
check("app sends at least 40 message types", sent.size >= 40);
const unhandled = [...sent].filter((t) => !handled.has(t));
check(`every type the app sends has a daemon handler${unhandled.length ? ": missing " + unhandled.join(", ") : ""}`, unhandled.length === 0);

const ws = fs.readFileSync(path.join(APP, "WsClient.kt"), "utf8");
const body = ws.slice(ws.indexOf("private fun handle(text: String)"));
const received = new Set();
for (const m of body.matchAll(/^ {12}("[a-z_]+"(?:, "[a-z_]+")*) ->/gm)) {
  for (const t of m[1].matchAll(/"([a-z_]+)"/g)) received.add(t[1]);
}
const daemonSrc = walk(DAEMON, ".js").map((f) => fs.readFileSync(f, "utf8")).join("\n");
const emitted = new Set([...daemonSrc.matchAll(/type: ["']([a-z_]+)["']/g)].map((m) => m[1]));
check("app handles at least 40 message types", received.size >= 40);
const neverSent = [...received].filter((t) => !emitted.has(t));
check(`every type the app handles is sent by the daemon${neverSent.length ? ": never sent " + neverSent.join(", ") : ""}`, neverSent.length === 0);

// The generated table: `| \`type\` | \`src/handlers/x.js\` |` rows, one per message.
const daemonDir = path.join(REPO, "daemon");
// The daemon's wire version is declared once, by the compatibility baseline beside
// daemon/src; server.js reads it through version.js instead of carrying a second literal.
const compat = JSON.parse(fs.readFileSync(path.join(daemonDir, "protocol", "compat.json"), "utf8"));
const serverSource = fs.readFileSync(path.join(daemonDir, "src", "server.js"), "utf8");
check(
  `the daemon speaks the baseline protocol version (v${PROTOCOL_VERSION})`,
  PROTOCOL_VERSION === compat.protocolVersion,
  `daemon v${PROTOCOL_VERSION}, baseline v${compat.protocolVersion}`,
);
check(
  "the server takes its protocol version from version.js",
  /import \{[^}]*PROTOCOL_VERSION[^}]*\} from "\.\/version\.js"/.test(serverSource),
);
const readme = fs.readFileSync(path.join(daemonDir, "README.md"), "utf8");
const rows = [...readme.matchAll(/^\| `([a-z][a-z0-9_]*)` \| `([^`]+)` \|$/gm)].map((m) => ({ type: m[1], file: m[2] }));
const types = [...new Set(rows.map((r) => r.type))].sort();
check(`the documented protocol has message types (${types.length})`, types.length > 200, String(types.length));
check("each type is documented exactly once", types.length === rows.length, `${types.length} types, ${rows.length} rows`);

// 2. The file a type names must exist and declare that method.
const missingFile = rows.filter((r) => !fs.existsSync(path.join(daemonDir, r.file)));
check(`every documented handler file exists${missingFile.length ? ": " + missingFile.map((r) => r.file).join(", ") : ""}`, missingFile.length === 0);
const missingMethod = rows.filter((r) => {
  if (!fs.existsSync(path.join(daemonDir, r.file))) return false;
  const text = fs.readFileSync(path.join(daemonDir, r.file), "utf8");
  return !new RegExp(`(?:^|\\s)(?:async\\s+)?${r.type}\\s*\\(`, "m").test(text) && !new RegExp(`handlers\\.${r.type}\\s*=`).test(text);
});
check(`every documented type is declared where the table says${missingMethod.length ? ": " + missingMethod.map((r) => `${r.type} -> ${r.file}`).join(", ") : ""}`, missingMethod.length === 0);

// 3. Test coverage, ratcheted by a checked-in list of the messages that have none yet.
// A type counts as covered only as a quoted string literal in another test file: prose in a
// comment, or a longer type that merely contains the name, must not satisfy it.
const testText = fs
  .readdirSync(path.join(daemonDir, "test"))
  .filter((f) => f.endsWith(".mjs") && f !== "protocol-contract.test.mjs")
  .map((f) => fs.readFileSync(path.join(daemonDir, "test", f), "utf8"))
  .join("\n");
const quoted = (t) => testText.includes(`"${t}"`) || testText.includes(`'${t}'`);
const untested = types.filter((t) => !quoted(t));
const listed = fs
  .readFileSync(path.join(daemonDir, "protocol-untested.txt"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();

const NEW_GAPS = untested.filter((t) => !listed.includes(t));
check(`no message type is untested without being listed${NEW_GAPS.length ? ": " + NEW_GAPS.join(", ") : ""}`, NEW_GAPS.length === 0);

// The other direction: a listed type that now has a test is a stale entry, and leaving it there
// means the list stops meaning anything.
const STALE = listed.filter((t) => !untested.includes(t));
check(`protocol-untested.txt has no stale entries${STALE.length ? ": " + STALE.map((t) => `${t} is covered now - delete the line`).join("; ") : ""}`, STALE.length === 0);

const unknownListed = listed.filter((t) => !types.includes(t));
check(`the untested list only holds real types${unknownListed.length ? ": " + unknownListed.join(", ") : ""}`, unknownListed.length === 0);
check(
  `untested messages are a known minority (${untested.length} of ${types.length})`,
  untested.length <= Math.ceil(types.length * 0.45),
  `${untested.length}/${types.length}`,
);

// 4. An unknown type is refused with the documented error, and the socket stays usable.
const tmp = makeTmp("rh-contract-");
const port = 8880;
const cliPort = 8881;
const d = startDaemon(port, cliPort, { token: "contract-token", manifests: tmp, dataDir: path.join(tmp, "data") });
try {
  await d.ready;
  await waitForHealth(port);
  const c = await openAndHello(port, "contract-token");
  c.send({ type: "no_such_message_type" });
  const err = await c.next((m) => m.type === "error");
  check(`an unknown type answers "unknown type: <name>" (${err.message})`, err.message === "unknown type: no_such_message_type", err.message);
  check("the documented error names the type the client sent", /no_such_message_type/.test(err.message));
  // The connection must survive a wrong type: a dropped socket would look like a crash to the phone.
  c.send({ type: "sessions_get" });
  const sess = await c.next((m) => m.type === "sessions_get");
  check("the socket still works after an unknown type", Array.isArray(sess.items));
  c.ws.close();
} finally {
  await teardown(tmp);
}
finish();
