// Every message name the README documents as a client request must have a handler in
// daemon/src/handlers/. A name with no handler is a feature that does not exist, and the
// README is then advertising something a phone cannot do.
//
// The handler name is the message type: `handle()` looks up `handlers[msg.type]`, and each
// handler module returns an object of methods. This file reads those method names out of
// the sources (no import, so no server boot) and compares them with the README's list.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const handlersDir = path.join(REPO, "daemon", "src", "handlers");
const names = new Set();
for (const f of fs.readdirSync(handlersDir).filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(handlersDir, f), "utf8");
  // Methods of the object each module returns: four spaces of indentation, optional `async`.
  for (const m of text.matchAll(/^\s{4}(?:async\s+)?([a-z][a-z0-9_]*)\s*\(/gm)) names.add(m[1]);
}
const serverText = fs.readFileSync(path.join(REPO, "daemon", "src", "server.js"), "utf8");
// A few handlers are added to the map directly in server.js (e.g. the loopback-only ones).
for (const m of serverText.matchAll(/handlers\.([a-z][a-z0-9_]*)\s*=/g)) names.add(m[1]);

check(`handler modules expose message types (${names.size} found)`, names.size > 100);
check("a known handler is present", names.has("chatsession") && names.has("fs_op") && names.has("display_extend"));

const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const from = readme.indexOf("**Client → Server:**");
const to = readme.indexOf("**Server → Client:**");
check("the README still has a client-to-server section", from > 0 && to > from);
const block = readme.slice(from, to);
// The whole protocol chapter, for the reverse check: a name documented anywhere in it
// (as a request, a broadcast or a reply) counts as documented.
const chapterStart = readme.lastIndexOf("## ", from);
const chapterEnd = readme.indexOf("\n## ", from);
const chapter = readme.slice(chapterStart, chapterEnd);

const backticked = (text) => [...new Set(
  [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].split(/[\s{]/)[0].replace(/[^a-z0-9_]/gi, ""))
    .filter((n) => n.length > 1),
)];
const documented = backticked(block);
const documentedAnywhere = backticked(chapter);
check(`the README documents client message types (${documented.length} found)`, documented.length > 40);

// `hello` is handled in the connection handshake, before the handler map is consulted.
const HANDSHAKE = new Set(["hello"]);
const noHandler = documented.filter((n) => !names.has(n) && !HANDSHAKE.has(n));
check(
  noHandler.length === 0
    ? "every documented client message has a handler"
    : `every documented client message has a handler (no handler: ${noHandler.join(", ")})`,
  noHandler.length === 0,
);

// The reverse direction: a message the phone sends that the README never documents is a
// doc gap, not a bug, so it is reported but only the well-known ones are required to be listed.
const UIDIR = path.join(REPO, "daemon", "public", "ui");
const sent = new Set();
for (const f of fs.readdirSync(UIDIR).filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(UIDIR, f), "utf8");
  for (const m of text.matchAll(/send\(\{\s*type:\s*"([a-z0-9_]+)"/g)) sent.add(m[1]);
}
const MISSING_DOC = [...sent].filter((n) => !documentedAnywhere.includes(n) && !HANDSHAKE.has(n));
check(
  MISSING_DOC.length === 0
    ? "the browser UI sends nothing the README leaves out"
    : `the browser UI sends nothing the README leaves out (undocumented: ${MISSING_DOC.join(", ")})`,
  MISSING_DOC.length === 0,
);

// And the specific claim that had drifted: TOTP is an HTTP endpoint, not a WS message.
check("the README does not list TOTP as a WebSocket message", !/`totp_(status|setup|enable|disable)`/.test(readme));
const serverRoutes = ["/access/totp/setup", "/access/totp/enable", "/access/totp/disable"];
check("the TOTP endpoints the README names exist in server.js", serverRoutes.every((r) => serverText.includes(r)));

finish();
