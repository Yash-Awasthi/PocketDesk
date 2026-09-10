import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Tmux absorption test — exercises the tmux session manager protocol surface
// (webmux inspiration: sessions that survive daemon restarts). Hermetic when
// tmux is not installed: list/create must answer gracefully, not crash. When
// tmux IS present, the full create → list → kill lifecycle is asserted.
import { execFileSync } from "node:child_process";

const tmp = makeTmp("rh-tmux-");

const PORT = 8803;
const CLI_PORT = 46803;
const TOKEN = "tmuxtoken";

let tmuxPresent = false;
try {
  execFileSync("tmux", ["-V"], { encoding: "utf8" });
  tmuxPresent = true;
} catch {
  tmuxPresent = false;
}

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // List: always answers with the availability flag and an items array.
  c.send({ type: "tmux_list" });
  const list = await c.next((m) => m.type === "tmux_list");
  check("tmux_list answers with available + items", typeof list.available === "boolean" && Array.isArray(list.items));
  check("tmux availability matches this machine", list.available === tmuxPresent);

  if (tmuxPresent) {
    // Full lifecycle: create → appears in list → capture is a string → kill.
    const name = `rh-test-${Date.now()}`;
    c.send({ type: "tmux_create", name });
    const created = await c.next((m) => m.type === "tmux_created" && m.name === name);
    check("tmux_create reports created", created.created === true);

    c.send({ type: "tmux_list" });
    const afterCreate = await c.next((m) => m.type === "tmux_list");
    check("created session appears in tmux_list", afterCreate.items.some((s) => s.name === name && typeof s.windows === "number"));

    c.send({ type: "tmux_capture", name, lines: 5 });
    const capture = await c.next((m) => m.type === "tmux_capture" && m.name === name);
    check("tmux_capture returns pane text", typeof capture.text === "string");

    c.send({ type: "tmux_kill", name });
    const killed = await c.next((m) => m.type === "tmux_killed" && m.name === name);
    check("tmux_kill reports killed", killed.killed === true);

    c.send({ type: "tmux_list" });
    const afterKill = await c.next((m) => m.type === "tmux_list");
    check("killed session gone from tmux_list", !afterKill.items.some((s) => s.name === name));
  } else {
    // No tmux: create must fail gracefully, never crash the daemon.
    c.send({ type: "tmux_create", name: "should-fail" });
    const failed = await c.next((m) => m.type === "tmux_created");
    check("tmux_create fails gracefully without tmux", failed.created === false && typeof failed.error === "string");

    c.send({ type: "tmux_kill", name: "nope" });
    const killed = await c.next((m) => m.type === "tmux_killed");
    check("tmux_kill fails gracefully without tmux", killed.killed === false);
  }

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });