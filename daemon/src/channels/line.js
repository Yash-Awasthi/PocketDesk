/**
 * LINE Channel — push notifications via LINE Messaging API.
 * Requires: LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID (or LINE_GROUP_ID)
 */
export class LineChannel {
  name = "line";

  constructor({ channelAccessToken, userId, groupId }) {
    this.token = channelAccessToken;
    this.to = userId || groupId;
    this.isGroup = !userId && !!groupId;
  }

  async send(text) {
    if (!this.token || !this.to) return;
    try {
      const url = "https://api.line.me/v2/bot/message/push";
      const body = {
        to: this.to,
        messages: [{ type: "text", text }],
      };
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(`[line] send failed: ${e.message}`);
    }
  }
}
