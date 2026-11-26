// The Running page: the pure snapshot builder first, then a live daemon answering running_state
// and serving the page's script.
import fs from "node:fs";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import { daemonVersion, snapshot } from "../src/running.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// ── the pure half, no daemon ──
const empty = snapshot({ version: "1.2.3", now: 0 });
check("no sessions by default", empty.sessions.count === 0 && empty.sessions.items.length === 0);
check(
  "no streams by default",
  empty.streams.video === 0 &&
    empty.streams.desktop === 0 &&
    empty.streams.audio === 0 &&
    empty.streams.remote === 0,
);
check(
  "every policy switch off by default",
  Object.values(empty.policy).every((v) => v === false),
);
check("a missing version reads unknown", snapshot({}).version.daemon === "unknown");
check("the time is ISO", empty.at === "1970-01-01T00:00:00.000Z");

const built = snapshot({
  version: "9.9.9",
  ports: { daemon: "8941", page: 8951, cli: "abc", usb: undefined },
  sessions: [
    { id: "0123456789abcdef", harnessId: "node", state: "running", bytes: 4096 },
    { id: 7, harnessId: null, bytes: "nope" },
  ],
  streams: { video: "2", desktop: 1, audio: 0, remote: 2 },
  policy: { control: true, remote: 1, password: 0, totp: true, recording: false },
  now: 0,
});
check(
  "ports are numbers, never NaN",
  [built.ports.daemon, built.ports.page, built.ports.cli, built.ports.usb].every((n) => Number.isFinite(n)),
);
check("a port given as text becomes its number", built.ports.daemon === 8941 && built.ports.cli === 0);
check(
  "sessions are normalised",
  built.sessions.count === 2 &&
    built.sessions.items[0].kind === "terminal" &&
    built.sessions.items[1].cwd === "" &&
    built.sessions.items[1].harnessId === "",
);
check("streams are counted", built.streams.video === 2 && built.streams.remote === 2);
check(
  "session output bytes are carried, junk becomes 0",
  built.sessions.items[0].bytes === 4096 && built.sessions.items[1].bytes === 0,
);
check(
  "policy flags are booleans",
  built.policy.control === true && built.policy.password === false && built.policy.recording === false,
);
check("the snapshot carries no credential words", !/token|secret/.test(JSON.stringify(built)));
check("daemonVersion reads package.json", daemonVersion() === pkg.version);

// ── the live half ──
const tmp = makeTmp("rh-running-");
// 8941 was taken by an unrelated local server when this landed; these two are free.
const PORT = 8893;
const CLI_PORT = 46893;
const TOKEN = "runningtoken";
const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
await d.ready;
try {
  const c = await openAndHello(PORT, TOKEN);
  c.send({ type: "running_state" });
  const first = await c.next((m) => m.type === "running_state");
  check("daemon version matches package.json", first.version.daemon === pkg.version);
  check(
    "the live daemon and CLI ports are reported",
    first.ports.daemon === PORT && first.ports.cli === CLI_PORT,
  );
  check("starts with no sessions", first.sessions.count === 0);
  check("starts with no video streams", first.streams.video === 0);
  check("control is allowed", first.policy.control === true);

  c.send({ type: "create", harness: "node", args: ["-e", "setInterval(()=>{},1000)"] });
  await c.next((m) => m.type === "created");
  c.send({ type: "running_state" });
  const live = await c.next((m) => m.type === "running_state");
  check(
    "a live session is listed",
    live.sessions.count >= 1 && live.sessions.items.some((it) => it.harnessId === "node"),
  );
  check(
    "every listed session carries a byte counter",
    live.sessions.items.every((it) => Number.isInteger(it.bytes) && it.bytes >= 0),
  );

  // A session that prints grows its counter, which is what the Running page reads.
  c.send({ type: "create", harness: "node", args: ["-e", "setInterval(() => console.log('rhbytes'), 200)"] });
  const chatty = await c.next((m) => m.type === "created", 15000);
  let mine = null;
  for (let i = 0; i < 20 && !(mine && mine.bytes > 0); i++) {
    c.send({ type: "running_state" });
    const counted = await c.next((m) => m.type === "running_state");
    mine = counted.sessions.items.find((it) => it.id === chatty.id);
    if (!(mine && mine.bytes > 0)) await new Promise((r) => setTimeout(r, 200));
  }
  check("the session's byte counter grew with its output", mine && mine.bytes > 0);

  const script = await fetch(`http://127.0.0.1:${PORT}/ui/running.js`);
  check("the page's script is served", script.status === 200);
  const page = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  check("the hub page loads it", page.includes("/ui/running.js"));
  await c.close();
} catch (e) {
  check("running flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
