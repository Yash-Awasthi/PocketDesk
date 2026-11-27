// Approval decisions for command, file write and diff requests: each one denied,
// allowed, and allow-all-for-session, driven through the real tool_approval.request path.
// No daemon, no WS: a fake broadcast collects the proposals the phone would see.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

// config.js reads RH_HOME at import time, so relocate state before loading the modules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-approvals-matrix-"));
process.env.RH_HOME = home;

const proposals = await import("../src/proposals.js");
const toolApproval = await import("../src/tool_approval.js");

// Broadcast queue: a proposal is only reachable after its proposal_created message.
const queue = [];
const waiting = [];
let createdCount = 0;

function capture(msg) {
  if (msg.type === "proposal_created") createdCount++;
  queue.push(msg);
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i];
    if (w.pred(msg)) {
      waiting.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
  }
}

function next(pred, timeoutMs = 5000) {
  const i = queue.findIndex(pred);
  if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(w), 1);
      reject(new Error("timed out waiting for a broadcast"));
    }, timeoutMs);
    waiting.push(w);
  });
}

const cases = [
  {
    name: "command",
    agentSession: "agent-cmd",
    owner: "owner-cmd",
    tool: "Bash",
    input: { command: "echo hi" },
    type: "command_execute",
    summary: "echo hi",
    detail: (d) =>
      d.tool === "Bash" &&
      d.input.command === "echo hi" &&
      d.agentSession === "agent-cmd" &&
      d.cwd === "C:/w",
  },
  {
    name: "file write",
    agentSession: "agent-write",
    owner: "owner-write",
    tool: "Write",
    input: { file_path: "C:/w/a.txt", content: "x" },
    type: "file_write",
    summary: "Write C:/w/a.txt",
    detail: (d) =>
      d.tool === "Write" &&
      d.input.file_path === "C:/w/a.txt" &&
      d.input.content === "x" &&
      d.agentSession === "agent-write" &&
      d.cwd === "C:/w",
  },
  {
    name: "diff",
    agentSession: "agent-edit",
    owner: "owner-edit",
    tool: "Edit",
    input: { file_path: "C:/w/a.txt", old_string: "a", new_string: "b" },
    type: "file_write",
    summary: "Edit C:/w/a.txt",
    detail: (d) =>
      d.tool === "Edit" &&
      d.input.file_path === "C:/w/a.txt" &&
      d.input.old_string === "a" &&
      d.input.new_string === "b" &&
      d.agentSession === "agent-edit" &&
      d.cwd === "C:/w",
  },
];

function assertProposal(name, p, c) {
  check(`${name}: proposal type is ${c.type}`, p.type === c.type);
  check(`${name}: proposal summary is ${JSON.stringify(c.summary)}`, p.summary === c.summary);
  check(`${name}: proposal sessionId is ${c.owner}`, p.sessionId === c.owner);
  check(`${name}: proposal detail keeps the tool input`, c.detail(p.detail));
  check(`${name}: proposal starts pending`, p.status === "pending");
}

async function main() {
  proposals.init(capture);
  toolApproval.init(0);

  for (const c of cases) {
    const request = () =>
      toolApproval.request({
        owner: c.owner,
        agentSession: c.agentSession,
        tool: c.tool,
        input: c.input,
        cwd: "C:/w",
      });

    // Deny: the rejection reaches the agent as a deny with a message.
    let pendingResult = request();
    let created = (await next((m) => m.type === "proposal_created")).proposal;
    assertProposal(`${c.name} deny`, created, c);
    const rejected = proposals.reject(created.id);
    check(`${c.name} deny: phone rejection is recorded`, rejected !== null && rejected.status === "rejected");
    let result = await pendingResult;
    check(`${c.name} deny: decision is deny`, result.decision === "deny");
    check(
      `${c.name} deny: deny carries a message`,
      typeof result.message === "string" && result.message.length > 0,
    );

    // Allow: approving the one proposal lets this request run.
    pendingResult = request();
    created = (await next((m) => m.type === "proposal_created")).proposal;
    assertProposal(`${c.name} allow`, created, c);
    const approved = proposals.approve(created.id);
    check(`${c.name} allow: phone approval is recorded`, approved !== null && approved.status === "approved");
    result = await pendingResult;
    check(`${c.name} allow: decision is allow`, result.decision === "allow");

    // Allow all: trusting the agent session answers later requests without a proposal.
    toolApproval.trust(c.agentSession);
    const before = createdCount;
    result = await request();
    await new Promise((r) => setTimeout(r, 150));
    check(`${c.name} allow-all: later request is allowed`, result.decision === "allow");
    check(`${c.name} allow-all: no new proposal reaches the phone`, createdCount === before);
  }
}

try {
  await main();
} catch (e) {
  check("approvals matrix: " + e.message, false);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  finish();
  process.exit(0);
}
