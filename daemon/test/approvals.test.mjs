// Claude Code permission prompts answered from the phone: a fake claude runs the real hook
// from the settings file the daemon passes it, and a client decides the resulting proposal.
import fs from "node:fs";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8851;
const CLI_PORT = 46851;
const TOKEN = "approvaltoken";
const tmp = makeTmp("rh-approvals-");

// Each turn asks for one Bash command and reports the hook's answer as assistant text.
const fake = path.join(tmp, "fakeclaude.js");
fs.writeFileSync(fake, `
const { execSync } = require("node:child_process");
const fs = require("node:fs");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const at = process.argv.indexOf("--settings");
  const hook = JSON.parse(fs.readFileSync(process.argv[at + 1], "utf8")).hooks.PermissionRequest[0].hooks[0].command;
  const input = JSON.stringify({ session_id: "agent-1", tool_name: "Bash", tool_input: { command: "echo " + prompt.trim() }, cwd: process.cwd() });
  const out = execSync(hook, { input, encoding: "utf8" }).trim();
  const answer = out ? JSON.parse(out).hookSpecificOutput.decision.behavior : "none";
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "decision=" + answer + " mode=" + (process.argv[process.argv.indexOf("--permission-mode") + 1] || "") } ] } }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: "" }));
});
`);
fs.writeFileSync(path.join(tmp, "fakeclaude.json"), JSON.stringify({
  id: "fakeclaude", name: "Fake Claude", adapter: "terminal", bin: "node", install: {},
  chat: { args: [fake], format: "claude-stream-json" },
}));

try {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({ type: "chatsession", harness: "fakeclaude", cwd: tmp, prompt: "first" });
  const created = await c.next((m) => m.type === "proposal_created" && m.proposal?.detail?.tool === "Bash", 20000);
  const p = created.proposal;
  check("proposal carries the command and the tool input", p.type === "command_execute" && p.summary === "echo first" && p.detail.input.command === "echo first");
  c.send({ type: "proposal_list" });
  const list = await c.next((m) => m.type === "proposal_list");
  check("pending approvals are listed for a reconnecting phone", list.items.some((i) => i.id === p.id));
  c.send({ type: "approve", id: p.id });
  const allowed = await c.next((m) => m.type === "chatdelta" && m.text.includes("decision="), 20000);
  check("approving lets the tool run", allowed.text.includes("decision=allow"));
  const chatId = allowed.id;

  c.send({ type: "chatmsg", id: chatId, text: "second" });
  const p2 = (await c.next((m) => m.type === "proposal_created" && m.proposal?.summary === "echo second", 20000)).proposal;
  c.send({ type: "reject", id: p2.id });
  const denied = await c.next((m) => m.type === "chatdelta" && m.text.includes("decision="), 20000);
  check("denying blocks the tool", denied.text.includes("decision=deny"));

  c.send({ type: "chatmsg", id: chatId, text: "third" });
  const p3 = (await c.next((m) => m.type === "proposal_created" && m.proposal?.summary === "echo third", 20000)).proposal;
  c.send({ type: "approve", id: p3.id, all: true });
  await c.next((m) => m.type === "chatdelta" && m.text.includes("decision=allow"), 20000);
  c.send({ type: "chatmsg", id: chatId, text: "fourth" });
  const auto = await c.next((m) => (m.type === "chatdelta" && m.text.includes("decision=")) || (m.type === "proposal_created" && m.proposal?.summary === "echo fourth"), 20000);
  check("allow all skips later prompts from the same agent session", auto.type === "chatdelta" && auto.text.includes("decision=allow"));

  c.send({ type: "chat_permission", id: chatId, mode: "autopilot" });
  await c.next((m) => m.type === "chat_permission_ok");
  c.send({ type: "chatmsg", id: chatId, text: "fifth" });
  const moded = await c.next((m) => m.type === "chatdelta" && m.text.includes("decision="), 20000);
  check("the chat's permission mode reaches claude", moded.text.includes("mode=acceptEdits"));

  const res = await fetch(`http://127.0.0.1:${CLI_PORT}/approval`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
  check("the approval endpoint refuses a wrong key", res.status === 401);
  await c.close();
} catch (e) {
  check("approvals flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
