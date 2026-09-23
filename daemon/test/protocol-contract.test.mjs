// Static contract between the Android app and the daemon, checked without a
// device: every type the app sends has a handler, every type it handles is sent.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";
import agentsHandlers from "../src/handlers/agents.js";
import filesHandlers from "../src/handlers/files.js";
import remoteHandlers from "../src/handlers/remote.js";
import sshHandlers from "../src/handlers/ssh.js";
import systemHandlers from "../src/handlers/system.js";

const APP = path.join(REPO, "app", "app", "src", "main", "java", "com", "yasha", "pocketdesk");
const DAEMON = path.join(REPO, "daemon", "src");

function walk(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
}

const handled = new Set(["hello"]);
for (const make of [agentsHandlers, filesHandlers, remoteHandlers, sshHandlers, systemHandlers]) {
  for (const k of Object.keys(make({}))) handled.add(k);
}

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

finish();
