/**
 * Notification Manager
 *
 * Channel registry + per-channel rate limiting + message queue.
 * Channels: Telegram, Discord, Email — registered via environment variables.
 */
import { TelegramChannel } from "./channels/telegram.js";
import { DiscordChannel } from "./channels/discord.js";
import { EmailChannel } from "./channels/email.js";

const RATE_LIMIT_MS = 10_000; // 1 message per channel per 10 seconds

/**
 * Create a notification manager.
 * @param {object} ctx - { config: { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL } }
 * @returns {{ send(event, data): void, channels(): string[] }}
 */
export function createNotificationManager(ctx) {
  const channels = [];
  const lastSent = new Map();   // channel.name → timestamp
  const queues = new Map();     // channel.name → [{ event, data, timer }]

  // ── Auto-discover channels from env ──
  if (ctx.config?.TELEGRAM_BOT_TOKEN && ctx.config?.TELEGRAM_CHAT_ID) {
    channels.push(new TelegramChannel({
      token: ctx.config.TELEGRAM_BOT_TOKEN,
      chatId: ctx.config.TELEGRAM_CHAT_ID,
    }));
  }
  if (ctx.config?.DISCORD_WEBHOOK_URL) {
    channels.push(new DiscordChannel({
      webhookUrl: ctx.config.DISCORD_WEBHOOK_URL,
    }));
  }
  if (ctx.config?.SMTP_HOST && ctx.config?.NOTIFY_EMAIL) {
    channels.push(new EmailChannel({
      host: ctx.config.SMTP_HOST,
      port: ctx.config.SMTP_PORT || 587,
      user: ctx.config.SMTP_USER,
      pass: ctx.config.SMTP_PASS,
      to: ctx.config.NOTIFY_EMAIL,
      from: ctx.config.SMTP_FROM || "PocketDesk <noreply@localhost>",
    }));
  }

  if (channels.length) {
    console.log(`  notifications: ${channels.map(c => c.name).join(", ")}`);
  }

  // ── Rate-limited send ──
  function send(event, data) {
    for (const ch of channels) {
      const now = Date.now();
      const last = lastSent.get(ch.name) || 0;
      const elapsed = now - last;

      if (elapsed >= RATE_LIMIT_MS) {
        // Send immediately
        lastSent.set(ch.name, now);
        ch.send(event, data).catch(err => {
          console.error(`  notification[${ch.name}] failed:`, err.message);
        });
      } else {
        // Queue and schedule flush
        if (!queues.has(ch.name)) queues.set(ch.name, []);
        const queue = queues.get(ch.name);
        queue.push({ event, data });
        if (!queue._flushing) {
          queue._flushing = true;
          const delay = RATE_LIMIT_MS - elapsed;
          const timer = setTimeout(() => {
            flush(ch, queue);
          }, delay);
          queue._timer = timer;
        }
      }
    }
  }

  function flush(ch, queue) {
    queue._flushing = false;
    const item = queue.shift();
    if (!item) return;
    const now = Date.now();
    lastSent.set(ch.name, now);
    ch.send(item.event, item.data).catch(err => {
      console.error(`  notification[${ch.name}] failed:`, err.message);
    });
    // If more items queued, schedule next flush
    if (queue.length > 0 && !queue._flushing) {
      queue._flushing = true;
      queue._timer = setTimeout(() => flush(ch, queue), RATE_LIMIT_MS);
    }
  }

  return {
    send,
    channels: () => channels.map(c => c.name),
    count: () => channels.length,
  };
}

// ── Pre-built message formatters ──

export const NotificationEvents = {
  PROPOSAL_CREATED: "proposal_created",
  PROPOSAL_APPROVED: "proposal_approved",
  PROPOSAL_REJECTED: "proposal_rejected",
  SESSION_CONNECTED: "session_connected",
  SESSION_ERROR: "session_error",
  CHAT_COMPLETED: "chat_completed",
};
