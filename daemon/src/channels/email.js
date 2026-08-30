/**
 * Email Notification Channel
 *
 * Sends HTML + plaintext emails via SMTP (nodemailer-compatible transport).
 * Uses native fetch to a local SMTP relay, or a simple direct socket approach.
 * For simplicity, we format and log emails; production would use nodemailer.
 */
import net from "node:net";
import crypto from "node:crypto";

export class EmailChannel {
  constructor({ host, port, user, pass, to, from }) {
    this.name = "email";
    this.host = host;
    this.port = port || 587;
    this.user = user;
    this.pass = pass;
    this.to = to;
    this.from = from;
  }

  async send(event, data) {
    const { subject, html, text } = this._buildContent(event, data);
    const messageId = `<${crypto.randomUUID()}@pocketdesk>`;

    // Build raw SMTP message
    const rawLines = [
      `From: ${this.from}`,
      `To: ${this.to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="rh-${Date.now()}"`,
      ``,
      `--rh-${Date.now()}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      text,
      ``,
      `--rh-${Date.now()}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
      ``,
      `--rh-${Date.now()}--`,
    ];

    try {
      await this._smtpSend(rawLines.join("\r\n"));
    } catch (err) {
      // Fallback: log the email content
      console.error(`  email[${this.to}] SMTP failed (${err.message}), logged instead:`);
      console.error(`    Subject: ${subject}`);
      console.error(`    Body: ${text.substring(0, 200)}`);
    }
  }

  _buildContent(event, data) {
    const titles = {
      proposal_created: "New Proposal Requires Approval",
      proposal_approved: "Proposal Approved",
      proposal_rejected: "Proposal Rejected",
      session_connected: "Session Connected",
      session_error: "Session Error",
      chat_completed: "Chat Task Completed",
    };

    const subject = `[PocketDesk] ${titles[event] || event}`;
    const details = data.summary || data.id || data.message || JSON.stringify(data);

    const text = `PocketDesk Notification\n\nEvent: ${event}\nDetails: ${details}\nTime: ${new Date().toISOString()}`;

    const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
  .card { background: #1a1a2e; border-radius: 8px; padding: 24px; max-width: 480px; border-left: 4px solid ${data.type ? "#5cb85c" : "#337ab7"}; }
  h2 { color: #fff; margin: 0 0 12px; font-size: 18px; }
  .detail { color: #aaa; font-size: 14px; line-height: 1.5; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: #337ab7; color: #fff; }
  .footer { color: #666; font-size: 12px; margin-top: 16px; }
</style></head><body>
<div class="card">
  <h2>${titles[event] || event}</h2>
  <div class="detail">
    <p><strong>Details:</strong> ${details}</p>
    ${data.type ? `<p><span class="badge">${data.type}</span></p>` : ""}
    ${data.harness ? `<p><strong>Harness:</strong> ${data.harness}</p>` : ""}
  </div>
  <div class="footer">PocketDesk • ${new Date().toISOString()}</div>
</div>
</body></html>`;

    return { subject, html, text };
  }

  async _smtpSend(rawMessage) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      let buffer = "";
      let step = 0;

      const commands = [
        `EHLO pocketdesk.local`,
        `AUTH LOGIN`,
        Buffer.from(this.user).toString("base64"),
        Buffer.from(this.pass).toString("base64"),
        `MAIL FROM:<${this.from}>`,
        `RCPT TO:<${this.to}>`,
        `DATA`,
        rawMessage,
        `.`,
        `QUIT`,
      ];

      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error("SMTP timeout"));
      }, 15000);

      sock.on("connect", () => { /* wait for greeting */ });

      sock.on("data", (chunk) => {
        buffer += chunk.toString();
        // Wait for positive response (2xx or 3xx)
        const lines = buffer.split("\r\n");
        const lastLine = lines.findLast(l => l.length > 0);
        if (!lastLine) return;

        const code = parseInt(lastLine.substring(0, 3), 10);
        if (isNaN(code)) return;

        buffer = "";
        if (code >= 200 && code < 400) {
          if (step < commands.length) {
            sock.write(commands[step] + "\r\n");
            step++;
          } else {
            clearTimeout(timeout);
            sock.destroy();
            resolve();
          }
        } else if (code >= 400) {
          clearTimeout(timeout);
          sock.destroy();
          reject(new Error(`SMTP ${code}: ${lastLine}`));
        }
      });

      sock.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      sock.on("close", () => {
        clearTimeout(timeout);
        resolve(); // Best effort
      });
    });
  }
}
