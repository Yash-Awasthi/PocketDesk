/**
 * Slack Channel — push notifications via Slack Incoming Webhook.
 * Requires: SLACK_WEBHOOK_URL
 */
export class SlackChannel {
  name = "slack";

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
      console.error(`[slack] send failed: ${e.message}`);
    }
  }
}
