/**
 * Pushover Notification Channel — phone push via the Pushover API.
 *
 * Salvaged from the corpus push_notification_bridge.js (claude-code-remote-
 * control inspiration). Pushover is a paid, reliable push service with
 * priorities and emergency retry/ack — a good fit for approval requests.
 *
 * Requires: PUSHOVER_TOKEN (app key) + PUSHOVER_USER (user key) — env.
 * Optional: PUSHOVER_DEVICE (target a single device).
 */
export class PushoverChannel {
  name = "pushover";

  constructor({ token, user, device, apiBase }) {
    this.token = token;
    this.user = user;
    this.device = device || "";
    this.apiBase = apiBase || "https://api.pushover.net"; // overridable for tests
  }

  async send(event, data) {
    const text = this._formatMessage(event, data);
    // Pushover: 2 = high-priority (repeats until acknowledged) — right for
    // approval gates; 0 = normal. Emergency (-2) would need retry/ack params.
    const priority = event === "session_asking" || event === "proposal_created" ? 1 : 0;
    const params = new URLSearchParams({
      token: this.token,
      user: this.user,
      title: "PocketDesk",
      message: text,
      priority: String(priority),
    });
    if (this.device) params.set("device", this.device);
    const resp = await fetch(`${this.apiBase}/1/messages.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Pushover ${resp.status}: ${body.slice(0, 120)}`);
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
