// Fleet view absorption test — exercises the fleet_* protocol surface
// (terminalcontrol inspiration): grid add/remove/focus/resize, status updates
// with notification chips, stats, and the agents→fleet status bridge.
// Fully in-memory — deterministic, no external processes.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8812;
const CLI_PORT = 46812;
const TOKEN = "fleettoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Add two terminals; grid is 2x2 so both fit.
  const b1P = c.next((m) => m.type === "fleet_event" && m.event === "added" && m.name === "alpha");
  c.send({ type: "fleet_add", name: "alpha", sessionId: "s1" });
  const t1 = await c.next((m) => m.type === "fleet_terminal");
  const b1 = await b1P;
  check("fleet_add returns terminal + broadcast", t1.terminal.name === "alpha" && !!b1);

  c.send({ type: "fleet_add", name: "beta", sessionId: "s2" });
  const t2 = await c.next((m) => m.type === "fleet_terminal");
  check("second terminal gets distinct grid slot", t2.terminal.position.row !== t1.terminal.position.row || t2.terminal.position.col !== t1.terminal.position.col);

  // Status → waiting raises a high-priority chip.
  c.send({ type: "fleet_status", terminalId: t1.terminal.id, status: "waiting", message: "needs approval" });
  await c.next((m) => m.type === "fleet_status_ok");
  c.send({ type: "fleet_chips" });
  const chips1 = await c.next((m) => m.type === "fleet_chips");
  check("waiting status raises high chip", chips1.items.length === 1 && chips1.items[0].priority === "high" && chips1.items[0].terminalId === t1.terminal.id);

  // Focus clears pending flag + dismisses that terminal's chips.
  c.send({ type: "fleet_focus", terminalId: t1.terminal.id });
  const foc = await c.next((m) => m.type === "fleet_focused");
  check("fleet_focus acks", foc.ok === true);
  c.send({ type: "fleet_chips" });
  const chips2 = await c.next((m) => m.type === "fleet_chips");
  check("focus dismisses focused terminal's chips", chips2.items.length === 0);

  // Done status (from non-done) raises a medium chip.
  c.send({ type: "fleet_status", terminalId: t2.terminal.id, status: "done", message: "finished" });
  await c.next((m) => m.type === "fleet_status_ok");
  c.send({ type: "fleet_chips" });
  const chips3 = await c.next((m) => m.type === "fleet_chips");
  check("done transition raises medium chip", chips3.items.length === 1 && chips3.items[0].priority === "medium");

  // Grid view + stats.
  c.send({ type: "fleet_view" });
  const view = await c.next((m) => m.type === "fleet_view");
  check("fleet_view returns terminals + focus", view.terminals.length === 2 && view.focused && view.focused.id === t1.terminal.id);

  c.send({ type: "fleet_stats" });
  const stats = await c.next((m) => m.type === "fleet_stats");
  check("fleet_stats counts", stats.totalTerminals === 2 && stats.waitingTerminals === 1 && stats.pendingChips === 1);

  // Resize grid → relayout broadcast.
  c.send({ type: "fleet_resize", rows: 3, cols: 2 });
  const grid = await c.next((m) => m.type === "fleet_grid");
  check("fleet_resize relayouts", grid.grid.rows === 3 && grid.grid.cols === 2);

  // Remove.
  c.send({ type: "fleet_remove", terminalId: t1.terminal.id });
  const rm = await c.next((m) => m.type === "fleet_removed");
  check("fleet_remove acks", rm.ok === true);
  c.send({ type: "fleet_view" });
  const view2 = await c.next((m) => m.type === "fleet_view");
  check("removed terminal gone from view", view2.terminals.length === 1);

  // Agents→fleet bridge: an orchestrated agent projects into the grid on start.
  c.send({ type: "agent_create", agentType: "worker" });
  const agent = await c.next((m) => m.type === "agent_created", 20000);
  if (agent.session) {
    c.send({ type: "agent_start", id: agent.session.id });
    await c.next((m) => m.type === "agent_state" && m.event === "started" && m.session.id === agent.session.id, 20000);
    c.send({ type: "fleet_view" });
    const view3 = await c.next((m) => m.type === "fleet_view");
    const bridged = view3.terminals.find((t) => t.sessionId === agent.session.id);
    check("agent start projects into fleet grid", !!bridged && bridged.status === "running");
    // complete it and check the done status propagated
    c.send({ type: "agent_complete", id: agent.session.id });
    await c.next((m) => m.type === "agent_state" && m.event === "complete" && m.session.id === agent.session.id, 20000);
    c.send({ type: "fleet_view" });
    const view4 = await c.next((m) => m.type === "fleet_view");
    const done = view4.terminals.find((t) => t.sessionId === agent.session.id);
    check("agent completion marks fleet terminal done", !!done && done.status === "done");
  } else {
    check("agent start projects into fleet grid", false);
  }

  await c.close();
await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
