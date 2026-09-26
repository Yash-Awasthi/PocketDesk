// Claude Code PermissionRequest hook: asks the daemon, prints the phone's answer.
// Printing nothing leaves the normal prompt in charge, so any failure stays harmless.
const url = process.env.RH_APPROVAL_URL;
if (!url) process.exit(0);

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  try {
    const hook = JSON.parse(raw);
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.RH_APPROVAL_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        owner: process.env.RH_APPROVAL_OWNER,
        agentSession: hook.session_id,
        tool: hook.tool_name,
        // The daemon refuses bodies over 64 KB; a large Write only needs its start shown.
        input: Object.fromEntries(Object.entries(hook.tool_input || {}).map(([k, v]) => [k, typeof v === "string" && v.length > 12000 ? v.slice(0, 12000) + "\n…(truncated)" : v])),
        cwd: hook.cwd,
      }),
    });
    const { decision, message } = await res.json();
    if (decision !== "allow" && decision !== "deny") return;
    const out = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: out } }));
  } catch {
    // Daemon gone or reply malformed: fall back to the agent's own prompt.
  }
});
