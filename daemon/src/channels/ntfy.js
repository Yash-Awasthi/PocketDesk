/**
 * ntfy Notification Channel — phone push via the ntfy.sh pub/sub service.
 *
 * Salvaged from the corpus push_notification_bridge.js (claude-code-remote-
 * control inspiration): an agent finishing / asking / failing should buzz the
 * phone even when no browser or app is connected. ntfy needs no account —
 * any topic string becomes a push target (install the ntfy app, subscribe
 * to the same topic; use a hard-to-guess topic, it is the credential).
 *
 * Requires: NTFY_TOPIC (the topic to publish to) — env.
 * Optional: NTFY_SERVER (default https://ntfy.sh).
 */
export class NtfyChannel {
  name = "ntfy";

  constructor({ topic, server }) {
    this.topic = topic;
    this.server = (server || "https://ntfy.sh").replace(/\/+$/, "");
  }

  async send(event, data) {
    const text = this._formatMessage(event, data);
    const priority = event === "session_asking" || event === "proposal_created" || event === "session_error" ? "high" : "default";
    const resp = await fetch(`${this.server}/${encodeURIComponent(this.topic)}`, {
      method: "POST",
      headers: {
        "Title": "PocketDesk",
        "Priority": priority,
        "Tags": "robot",
      },
      body: text,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ntfy ${resp.status}: ${body.slice(0, 120)}`);
    }
  }

  _formatMessage(event, data) {
    switch (event) {
      case "proposal_created":
        return `📋 Proposal: ${data.summary || data.id || "unnamed"}`;
      case "proposal_approved":
        return `✅ Approved: ${data.summary || data.id || ""}`;
      case "proposal_rejected":
        return `❌ Rejected: ${data.summary || data.id || ""}`;
      case "session_connected":
        return `🔌 ${data.harness || "agent"} session connected${data.cwd ? ` (${data.cwd})` : ""}`;
      case "session_error":
        return `💥 Session error: ${data.message || data.id || "unknown"}`;
      case "session_asking":
        return `⏸ Waiting for your answer: ${data.summary || data.id || ""}`;
      case "session_quiet":
        return `🌙 Session went quiet: ${data.id || ""}`;
      case "chat_completed":
        return `💬 Chat finished: ${data.summary || data.id || ""}`;
      default:
        return `${event}: ${data?.summary || data?.id || ""}`.trim();
    }
  }
}
