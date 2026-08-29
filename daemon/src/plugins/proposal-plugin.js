/**
 * Proposal plugin — intercepts sensitive actions and routes through approval flow.
 *
 * Blocks file_write, command_execute, and network_request messages
 * until the user approves them via the UI.
 */
export default {
  name: "proposal-gate",
  version: "1.0.0",
  hooks: ["onMessage"],

  init(ctx) {
    this.proposals = ctx.proposals;
  },

  async onMessage(ctx, ws, msg) {
    // Only gate messages from chat sessions that want to execute actions
    if (msg.type !== "propose") return;

    const proposal = ctx.proposals.create({
      type: msg.proposalType || "command_execute",
      summary: msg.summary || "Unnamed action",
      detail: msg.detail || {},
      sessionId: msg.sessionId || "unknown",
    });

    return { block: true };
  },
};
