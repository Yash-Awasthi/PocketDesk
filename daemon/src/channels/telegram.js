/**
 * Telegram Notification Channel
 *
 * Sends formatted messages via Telegram Bot API.
 */
export class TelegramChannel {
  constructor({ token, chatId }) {
    this.name = "telegram";
    this.token = token;
    this.chatId = chatId;
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async send(event, data) {
    const text = this._formatMessage(event, data);
    const resp = await fetch(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Telegram API ${resp.status}: ${body}`);
    }
  }

  _formatMessage(event, data) {
    const lines = [`*PocketDesk*`];
    switch (event) {
      case "proposal_created":
        lines.push(`📋 New proposal: ${data.summary || "Unnamed"}`);
        lines.push(`Type: ${data.type || "unknown"}`);
        if (data.id) lines.push(`ID: \`${data.id}\``);
        break;
      case "proposal_approved":
        lines.push(`✅ Proposal approved: ${data.summary || data.id}`);
        break;
      case "proposal_rejected":
        lines.push(`❌ Proposal rejected: ${data.summary || data.id}`);
        break;
      case "session_connected":
        lines.push(`🟢 Session connected: ${data.harness || "unknown"}`);
        if (data.cwd) lines.push(`Dir: ${data.cwd}`);
        break;
      case "session_error":
        lines.push(`🔴 Session error: ${data.message || "Unknown error"}`);
        break;
      case "chat_completed":
        lines.push(`💬 Chat task completed`);
        if (data.summary) lines.push(data.summary);
        break;
      case "session_quiet":
        lines.push(`✅ Agent finished — session ${data.id} went quiet`);
        break;
      case "session_asking":
        lines.push(`❓ Agent needs input — session ${data.id} is waiting`);
        break;
      default:
        lines.push(`📢 ${event}: ${JSON.stringify(data)}`);
    }
    return lines.join("\n");
  }
}
