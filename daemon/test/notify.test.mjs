// Smart notifications (shooter) absorption test — exercises the notify_*
// protocol surface: decision-first delivery (permission requests always send),
// dedupe window, coalescing per project, idle gate, telemetry stats, bursts.
// Fully in-memory — deterministic, no external processes.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8811;
const CLI_PORT = 46811;
const TOKEN = "notifytoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Decision-first: permission requests always send, high priority.
  c.send({ type: "notify_send", projectId: "p1", eventType: "permission_request", text: "run rm -rf?" });
  const p1 = await c.next((m) => m.type === "notify_sent");
  check("permission request sends high-priority", p1.ok === true && p1.priority === "high");

  // Notify_event broadcast accompanies a send.
  const bcast = await c.next((m) => m.type === "notify_event");
  check("notify_event broadcast", bcast.event.type === "permission_request");

  // Dedupe: same project+type+text inside the window is dropped.
  c.send({ type: "notify_send", projectId: "p1", eventType: "info", text: "build done" });
  const first = await c.next((m) => m.type === "notify_sent" && m.ok === true && m.priority === "normal");
  check("normal info sends", first.ok === true);
  c.send({ type: "notify_send", projectId: "p1", eventType: "info", text: "build done" });
  const dupe = await c.next((m) => m.type === "notify_sent" && m.ok === false);
  check("duplicate inside dedup window dropped", dupe.reason === "deduplicated");

  // Coalescing: second distinct normal event within the window coalesces.
  c.send({ type: "notify_send", projectId: "p1", eventType: "info", text: "lint done" });
  const coal = await c.next((m) => m.type === "notify_sent" && m.ok === false);
  check("distinct event coalesces inside window", coal.reason === "coalesced");

  // Idle gate: internal events never send.
  c.send({ type: "notify_send", projectId: "p2", eventType: "info", text: "teammate idle" });
  const gated = await c.next((m) => m.type === "notify_sent" && m.ok === false);
  check("idle-gated events dropped", gated.reason === "idle_gated");

  // Different project is independent (no cross-project coalescing).
  c.send({ type: "notify_send", projectId: "p3", eventType: "info", text: "build done" });
  const other = await c.next((m) => m.type === "notify_sent" && m.ok === true);
  check("other project unaffected", other.ok === true);

  // Telemetry reflects everything.
  c.send({ type: "notify_stats" });
  const stats = await c.next((m) => m.type === "notify_stats");
  check("stats count sent/dropped/coalesced", stats.sent === 3 && stats.dropped === 2 && stats.coalesced === 1);
  // p1 saw: permission sent + info sent + 1 deduped + 1 coalesced →
  // {sent:2, dropped:1, coalesced:1}. The idle-gated drop belongs to p2.
  check("byProject breakdown", stats.byProject.p1 && stats.byProject.p1.dropped === 1 && stats.byProject.p1.coalesced === 1);

  // Bursts: >5 events in a window for one project → flagged.
  for (let i = 0; i < 7; i++) {
    c.send({ type: "notify_send", projectId: "bursty", eventType: "permission_request", text: "ask " + i });
    await c.next((m) => m.type === "notify_sent" && m.ok === true);
  }
  c.send({ type: "notify_bursts" });
  const bursts = await c.next((m) => m.type === "notify_bursts");
  check("burst detection flags bursty project", bursts.items.some((b) => b.projectId === "bursty" && b.count >= 7));

  await c.close();
await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
