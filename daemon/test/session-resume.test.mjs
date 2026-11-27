// The explicit restart, over a real ws and real PTYs: an exited session's command comes back
// under the same id and its queued replies run in order onto the new shell, while a live or
// expired session is refused with a code instead of being respawned.
import fs from "node:fs";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown, waitForHealth } from "./helpers.mjs";

const PORT = 8838;
const CLI_PORT = 46838;
const TTL_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const textOf = (m) => Buffer.from(String(m.data ?? ""), "base64").toString("utf8");

const tmp = makeTmp("pd-restart-");
const dataDir = path.join(tmp, "data");
const script = path.join(tmp, "echo.mjs");
fs.writeFileSync(
  script,
  `
import fs from "node:fs";
const marker = process.argv[2];
if (!fs.existsSync(marker)) process.exit(3);
process.stdout.write("READY\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => process.stdout.write("GOT:" + d.trim() + "\\n"));
process.stdin.resume();
`,
);
const marker = path.join(tmp, "alive");
const marker2 = path.join(tmp, "alive2");
const d = startDaemon(PORT, CLI_PORT, {
  token: "restart-token",
  manifests: tmp,
  dataDir,
  env: { RH_DEAD_SESSION_TTL_MS: String(TTL_MS) },
});
try {
  await d.ready;
  await waitForHealth(PORT);
  const c = await openAndHello(PORT, "restart-token");

  const create = async (aliveMarker) => {
    c.send({ type: "create", harness: "node", cwd: tmp, args: [script, aliveMarker] });
    const created = await c.next((m) => m.type === "created" || m.type === "error");
    check("create session answers created", created.type === "created");
    return created.id;
  };
  // Only the refusal the daemon sends back, or the list it broadcasts when it respawns: a
  // missing guard must fail the check instead of hanging until the test times out.
  const answer = (id) =>
    c.next(
      (m) =>
        (m.type === "error" && m.id === id) || (m.type === "sessions" && m.items.some((s) => s.id === id)),
      15_000,
    );

  // 1. An exited session comes back as the same command, and its queued input runs in order.
  const id = await create(marker);
  await c.next((m) => m.type === "exit" && m.id === id);
  check("the first run really exited", true);
  let seen = "";
  c.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "out" && m.id === id) seen += textOf(m);
  });
  c.send({ type: "in", id, data: b64("carry on\r") });
  c.send({ type: "in", id, data: b64("second\r") });
  fs.writeFileSync(marker, "1");
  c.send({ type: "session_resume", id });
  const resumed = await answer(id);
  check(
    "session_resume puts the session back in the live list",
    resumed.type === "sessions" && resumed.items.some((s) => s.id === id),
  );
  const deadline = Date.now() + 15_000;
  while (!(seen.includes("GOT:carry on") && seen.includes("GOT:second")) && Date.now() < deadline)
    await sleep(50);
  check("the same command spawned again (READY)", seen.includes("READY"));
  check("the first queued reply reached the new shell", seen.includes("GOT:carry on"));
  check("the second queued reply reached the new shell", seen.includes("GOT:second"));
  check(
    "the queued replies ran in order",
    seen.indexOf("GOT:carry on") < seen.indexOf("GOT:second") && seen.indexOf("GOT:carry on") >= 0,
  );

  // 2. A live session is refused: no second process, no queued text.
  const live = await create(marker);
  c.send({ type: "attach", id: live });
  await c.next((m) => m.type === "replay" && m.id === live);
  c.send({ type: "session_resume", id: live });
  const liveErr = await answer(live);
  check("a live session is refused with code session_live", liveErr.code === "session_live");
  check("the refusal names the live session", String(liveErr.message).includes(live));

  // 3. Past the queue TTL the session is refused as expired.
  const expired = await create(marker2);
  await c.next((m) => m.type === "exit" && m.id === expired);
  await sleep(TTL_MS + 500);
  c.send({ type: "session_resume", id: expired });
  const expiredErr = await answer(expired);
  check("an expired session is refused with code session_expired", expiredErr.code === "session_expired");
  check("the refusal names the queue window", /expired/.test(String(expiredErr.message)));

  // 4. An unknown id is refused, not invented.
  c.send({ type: "session_resume", id: "no-such-session" });
  const unknown = await c.next((m) => m.type === "error" && m.id === "no-such-session");
  check("an unknown id is refused with code session_unknown", unknown.code === "session_unknown");

  await c.close();
} finally {
  await teardown(tmp);
}
finish();
setTimeout(() => process.exit(0), 200);
