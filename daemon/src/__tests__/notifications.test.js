import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createNotificationManager, NotificationEvents } from "../notifications.js";
import { TelegramChannel } from "../channels/telegram.js";
import { DiscordChannel } from "../channels/discord.js";

describe("createNotificationManager", () => {
  it("creates with no channels when env is empty", () => {
    const mgr = createNotificationManager({ config: {} });
    assert.equal(mgr.count(), 0);
    assert.deepEqual(mgr.channels(), []);
  });

  it("discovers Telegram channel from config", () => {
    const mgr = createNotificationManager({
      config: { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "123" },
    });
    assert.equal(mgr.count(), 1);
    assert.ok(mgr.channels().includes("telegram"));
  });

  it("discovers Discord channel from config", () => {
    const mgr = createNotificationManager({
      config: { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test" },
    });
    assert.equal(mgr.count(), 1);
    assert.ok(mgr.channels().includes("discord"));
  });

  it("discovers multiple channels", () => {
    const mgr = createNotificationManager({
      config: {
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "123",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
      },
    });
    assert.equal(mgr.count(), 2);
    assert.ok(mgr.channels().includes("telegram"));
    assert.ok(mgr.channels().includes("discord"));
  });

  it("does not crash when sending with no channels", () => {
    const mgr = createNotificationManager({ config: {} });
    assert.doesNotThrow(() => mgr.send("test_event", { data: "test" }));
  });

  it("rate-limits sends per channel", async () => {
    // Mock fetch to prevent actual HTTP calls
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => "" };
    };

    const mgr = createNotificationManager({
      config: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "123" },
    });

    mgr.send(NotificationEvents.PROPOSAL_CREATED, { summary: "test1" });
    assert.equal(fetchCount, 1);

    // Second send should be queued (rate limited)
    mgr.send(NotificationEvents.PROPOSAL_CREATED, { summary: "test2" });
    assert.equal(fetchCount, 1); // Still 1

    globalThis.fetch = originalFetch;
  });
});

describe("TelegramChannel", () => {
  it("formats proposal created message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("proposal_created", { summary: "Write file", type: "file_write", id: "abc123" });
    assert.ok(msg.includes("Write file"));
    assert.ok(msg.includes("file_write"));
    assert.ok(msg.includes("abc123"));
  });

  it("formats session error message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("session_error", { message: "Connection refused" });
    assert.ok(msg.includes("Connection refused"));
    assert.ok(msg.includes("🔴"));
  });

  it("formats chat completed message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("chat_completed", { summary: "Done" });
    assert.ok(msg.includes("Done"));
    assert.ok(msg.includes("💬"));
  });

  it("formats unknown event as generic", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("custom_event", { key: "val" });
    assert.ok(msg.includes("custom_event"));
  });
});

describe("DiscordChannel", () => {
  it("builds embed with correct color for proposal", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("proposal_created", { summary: "Test", type: "file_write" });
    assert.ok(embed.title.includes("Proposal"));
    assert.equal(embed.color, 0xf0ad4e); // amber
    assert.ok(embed.fields.length > 0);
  });

  it("builds embed with green for approval", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("proposal_approved", { summary: "Approved" });
    assert.equal(embed.color, 0x5cb85c); // green
  });

  it("builds embed with red for error", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("session_error", { message: "Failed" });
    assert.equal(embed.color, 0xd9534f); // red
    assert.ok(embed.fields.some(f => f.value.includes("Failed")));
  });

  it("truncates long messages to 1024 chars", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const longMsg = "x".repeat(2000);
    const embed = ch._buildEmbed("session_error", { message: longMsg });
    const msgField = embed.fields.find(f => f.name === "Message");
    assert.ok(msgField.value.length <= 1024);
  });
});

describe("NotificationEvents", () => {
  it("has all required event constants", () => {
    assert.equal(NotificationEvents.PROPOSAL_CREATED, "proposal_created");
    assert.equal(NotificationEvents.PROPOSAL_APPROVED, "proposal_approved");
    assert.equal(NotificationEvents.PROPOSAL_REJECTED, "proposal_rejected");
    assert.equal(NotificationEvents.SESSION_CONNECTED, "session_connected");
    assert.equal(NotificationEvents.SESSION_ERROR, "session_error");
    assert.equal(NotificationEvents.CHAT_COMPLETED, "chat_completed");
  });
});
