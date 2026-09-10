import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Session multiplexer absorption test — exercises the mux_* protocol surface
// (agentpeek inspiration): tmux availability gate, validation errors surfaced
// as errorKind, list/summary on tmux-less machines. On machines with tmux the
// create/kill/list happy paths run for real; on tmux-less machines (e.g.
// Windows CI) the gate path asserts clean degradation instead.
import { execSync } from "node:child_process";

function hasTmux() {
  try { execSync("tmux -V", { encoding: "utf-8", timeout: 3000, stdio: "pipe" }); return true; } catch { return false; }
}

const tmp = makeTmp("rh-mux-");

const PORT = 8813;
const CLI_PORT = 46813;
const TOKEN = "muxtoken";

async function main() {
  const tmuxAvailable = hasTmux();
  console.log(`(tmux on this machine: ${tmuxAvailable ? "yes" : "no"})`);

  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Availability gate matches the host reality.
  c.send({ type: "mux_status" });
  const status = await c.next((m) => m.type === "mux_status");
  check("mux_status reports availability", status.available === tmuxAvailable);

  // List degrades cleanly without tmux.
  c.send({ type: "mux_list" });
  const list = await c.next((m) => m.type === "mux_list");
  if (!tmuxAvailable) {
    check("mux_list degrades cleanly without tmux", list.available === false && Array.isArray(list.items) && list.items.length === 0);
  } else {
    check("mux_list returns array with tmux", list.available === true && Array.isArray(list.items));
  }

  c.send({ type: "mux_summary" });
  const summ = await c.next((m) => m.type === "mux_summary");
  if (!tmuxAvailable) {
    check("mux_summary degrades cleanly without tmux", summ.available === false && summ.summary === null);
  } else {
    check("mux_summary returns counts with tmux", summ.available === true && typeof summ.summary.total === "number");
  }

  // Invalid names fail validation before any tmux call — on every platform.
  c.send({ type: "mux_create", name: "bad name!" });
  const invalid = await c.next((m) => m.type === "mux_created");
  check("invalid name rejected with kind", invalid.ok === false && invalid.errorKind === "InvalidName");

  c.send({ type: "mux_create", name: "" });
  const empty = await c.next((m) => m.type === "mux_created");
  check("empty name rejected", empty.ok === false && empty.errorKind === "InvalidName");

  if (tmuxAvailable) {
    // Real tmux: exercise the happy path.
    c.send({ type: "mux_create", name: "rh-test-session", cwd: tmp });
    const created = await c.next((m) => m.type === "mux_created");
    check("mux_create creates a real session", created.ok === true && created.name === "rh-test-session");

    c.send({ type: "mux_list" });
    const list2 = await c.next((m) => m.type === "mux_list");
    check("created session appears in list", list2.items.some((s) => s.name === "rh-test-session"));

    c.send({ type: "mux_waiting", name: "rh-test-session" });
    const waiting = await c.next((m) => m.type === "mux_waiting");
    check("mux_waiting checks pane markers", waiting.ok === true && waiting.waiting === false);

    c.send({ type: "mux_create", name: "rh-test-session" });
    const dupe = await c.next((m) => m.type === "mux_created");
    check("duplicate create rejected", dupe.ok === false);

    c.send({ type: "mux_kill", name: "rh-test-session" });
    const killed = await c.next((m) => m.type === "mux_killed");
    check("mux_kill removes session", killed.ok === true);
  } else {
    // No tmux: create fails gracefully (MuxError from the underlying command).
    c.send({ type: "mux_create", name: "rh-any" });
    const fail = await c.next((m) => m.type === "mux_created");
    check("create without tmux fails gracefully", fail.ok === false && fail.errorKind === "MuxError");
  }

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
