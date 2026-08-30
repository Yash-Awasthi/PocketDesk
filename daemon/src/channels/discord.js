/**
 * Discord Notification Channel
 *
 * Sends rich embeds via Discord webhook.
 */
const COLORS = {
  proposal_created: 0xf0ad4e,  // amber
  proposal_approved: 0x5cb85c,  // green
  proposal_rejected: 0xd9534f,  // red
  session_connected: 0x5cb85c,  // green
  session_error: 0xd9534f,      // red
  chat_completed: 0x337ab7,     // blue
};

export class DiscordChannel {
  constructor({ webhookUrl }) {
    this.name = "discord";
    this.webhookUrl = webhookUrl;
  }

  async send(event, data) {
    const embed = this._buildEmbed(event, data);
    const resp = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "PocketDesk",
        embeds: [embed],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Discord webhook ${resp.status}: ${body}`);
    }
  }

  _buildEmbed(event, data) {
    const titles = {
      proposal_created: "📋 New Proposal",
      proposal_approved: "✅ Proposal Approved",
      proposal_rejected: "❌ Proposal Rejected",
      session_connected: "🟢 Session Connected",
      session_error: "🔴 Session Error",
      chat_completed: "💬 Chat Completed",
    };

    const fields = [];
    if (data.summary || data.id) {
      fields.push({ name: "Details", value: data.summary || data.id, inline: true });
    }
    if (data.type) {
      fields.push({ name: "Type", value: data.type, inline: true });
    }
    if (data.harness) {
      fields.push({ name: "Harness", value: data.harness, inline: true });
    }
    if (data.message) {
      fields.push({ name: "Message", value: data.message.substring(0, 1024) });
    }
    if (data.cwd) {
      fields.push({ name: "Directory", value: `\`${data.cwd}\``, inline: true });
    }

    return {
      title: titles[event] || `📢 ${event}`,
      color: COLORS[event] || 0x999999,
      fields,
      timestamp: new Date().toISOString(),
    };
  }
}
