import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
// Agent orchestrator absorption test — exercises the multi-agent fleet
// protocol surface (1code inspiration): create → start → pause → resume →
// complete lifecycle, stats, status filtering, session messages, broadcast,
// and graceful unknown-id errors. Fully in-memory — no external processes.

const tmp = makeTmp("rh-agents-");

const PORT = 8805;
const CLI_PORT = 46805;
const TOKEN = "agenttoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Empty fleet.
  c.send({ type: "agent_list" });
  const empty = await c.next((m) => m.type === "agent_list");
  check("agent_list starts empty", Array.isArray(empty.items) && empty.items.length === 0);

  // Create two agents of different types.
  c.send({ type: "agent_create", agentType: "claude", systemPrompt: "be brief", metadata: { project: "x" } });
  const created1 = await c.next((m) => m.type === "agent_created");
  check("agent_create returns a session", typeof created1.session?.id === "string" && created1.session.agentType === "claude");
  c.send({ type: "agent_create", agentType: "codex" });
  const created2 = await c.next((m) => m.type === "agent_created" && m.session?.agentType === "codex");
  check("second agent created", !!created2.session?.id);

  // State-change broadcast reaches the same client.
  c.send({ type: "agent_start", id: created1.session.id });
  const started = await c.next((m) => m.type === "agent_state" && m.event === "started" && m.session?.id === created1.session.id);
  check("agent_start broadcasts agent_state started", started.session.status === "running");

  c.send({ type: "agent_pause", id: created1.session.id });
  await c.next((m) => m.type === "agent_state" && m.event === "paused" && m.session?.id === created1.session.id);
  c.send({ type: "agent_resume", id: created1.session.id });
  const resumed = await c.next((m) => m.type === "agent_state" && m.event === "resumed" && m.session?.id === created1.session.id);
  check("pause→resume round-trips", resumed.session.status === "running");

  c.send({ type: "agent_complete", id: created1.session.id });
  await c.next((m) => m.type === "agent_state" && m.event === "completed" && m.session?.id === created1.session.id);
  c.send({ type: "agent_complete", id: created2.session.id });
  await c.next((m) => m.type === "agent_state" && m.event === "completed" && m.session?.id === created2.session.id);

  // Stats reflect the fleet.
  c.send({ type: "agent_stats" });
  const stats = await c.next((m) => m.type === "agent_stats");
  check("agent_stats counts fleet", stats.total === 2 && stats.completed === 2 && stats.active === 0);

  // Status filter.
  c.send({ type: "agent_list", status: "completed" });
  const completed = await c.next((m) => m.type === "agent_list");
  console.error("DBG completed:", JSON.stringify(completed)); check("agent_list filters by status", completed.items.length === 2);
  c.send({ type: "agent_list", status: "running" });
  const running = await c.next((m) => m.type === "agent_list");
  check("agent_list running filter empty", running.items.length === 0);

  // Session messages.
  c.send({ type: "agent_say", id: created1.session.id, content: "hello agent" });
  const said = await c.next((m) => m.type === "agent_said");
  check("agent_say records a message", said.messageCount >= 1);
  c.send({ type: "agent_say", id: "nope", content: "x" });
  const sayErr = await c.next((m) => m.type === "agent_error");
  check("agent_say unknown id errors gracefully", /not found/i.test(sayErr.message));

  // Unknown-id state changes never crash the daemon.
  c.send({ type: "agent_start", id: "missing" });
  const startErr = await c.next((m) => m.type === "agent_error");
  check("agent_start unknown id errors gracefully", /not found/i.test(startErr.message));

  // Broadcast reaches running sessions only (all completed now → 0 recipients).
  c.send({ type: "agent_broadcast", message: "stand by" });
  const bcast = await c.next((m) => m.type === "agent_broadcast_sent");
  check("agent_broadcast acks", !!bcast);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });