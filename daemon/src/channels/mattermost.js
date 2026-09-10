/**
 * Mattermost Channel — push notifications via a Mattermost Incoming Webhook.
 *
 * Absorbed from claude-threads (Slack *and* Mattermost support, so chat push
 * also works where the workspace is self-hosted and cloud-only integrations
 * cannot go). Requires: MATTERMOST_WEBHOOK_URL
 */
export class MattermostChannel {
  name = "mattermost";

  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl;
  }

  async send(text) {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      console.error(`[mattermost] send failed: ${e.message}`);
    }
  }
}
