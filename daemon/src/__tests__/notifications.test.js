import { describe, it, expect, vi } from "vitest";
import { createNotificationManager, NotificationEvents } from "../notifications.js";
import { TelegramChannel } from "../channels/telegram.js";
import { DiscordChannel } from "../channels/discord.js";

describe("createNotificationManager", () => {
  it("creates with no channels when env is empty", () => {
    const mgr = createNotificationManager({ config: {} });
    expect(mgr.count()).toBe(0);
    expect(mgr.channels()).toEqual([]);
  });

  it("discovers Telegram channel from config", () => {
    const mgr = createNotificationManager({
      config: { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "123" },
    });
    expect(mgr.count()).toBe(1);
    expect(mgr.channels()).toContain("telegram");
  });

  it("discovers Discord channel from config", () => {
    const mgr = createNotificationManager({
      config: { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test" },
    });
    expect(mgr.count()).toBe(1);
    expect(mgr.channels()).toContain("discord");
  });

  it("discovers multiple channels", () => {
    const mgr = createNotificationManager({
      config: {
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "123",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
      },
    });
    expect(mgr.count()).toBe(2);
    expect(mgr.channels()).toContain("telegram");
    expect(mgr.channels()).toContain("discord");
  });

  it("does not crash when sending with no channels", () => {
    const mgr = createNotificationManager({ config: {} });
    expect(() => mgr.send("test_event", { data: "test" })).not.toThrow();
  });

  it("rate-limits sends per channel", async () => {
    // Mock fetch to prevent actual HTTP calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });

    const mgr = createNotificationManager({
      config: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "123" },
    });

    mgr.send(NotificationEvents.PROPOSAL_CREATED, { summary: "test1" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second send should be queued (rate limited)
    mgr.send(NotificationEvents.PROPOSAL_CREATED, { summary: "test2" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // Still 1

    globalThis.fetch = originalFetch;
  });
});

describe("TelegramChannel", () => {
  it("formats proposal created message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("proposal_created", { summary: "Write file", type: "file_write", id: "abc123" });
    expect(msg).toContain("Write file");
    expect(msg).toContain("file_write");
    expect(msg).toContain("abc123");
  });

  it("formats session error message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("session_error", { message: "Connection refused" });
    expect(msg).toContain("Connection refused");
    expect(msg).toContain("🔴");
  });

  it("formats chat completed message", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("chat_completed", { summary: "Done" });
    expect(msg).toContain("Done");
    expect(msg).toContain("💬");
  });

  it("formats unknown event as generic", () => {
    const ch = new TelegramChannel({ token: "test", chatId: "123" });
    const msg = ch._formatMessage("custom_event", { key: "val" });
    expect(msg).toContain("custom_event");
  });
});

describe("DiscordChannel", () => {
  it("builds embed with correct color for proposal", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("proposal_created", { summary: "Test", type: "file_write" });
    expect(embed.title).toContain("Proposal");
    expect(embed.color).toBe(0xf0ad4e); // amber
    expect(embed.fields.length).toBeGreaterThan(0);
  });

  it("builds embed with green for approval", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("proposal_approved", { summary: "Approved" });
    expect(embed.color).toBe(0x5cb85c); // green
  });

  it("builds embed with red for error", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const embed = ch._buildEmbed("session_error", { message: "Failed" });
    expect(embed.color).toBe(0xd9534f); // red
    expect(embed.fields.some(f => f.value.includes("Failed"))).toBe(true);
  });

  it("truncates long messages to 1024 chars", () => {
    const ch = new DiscordChannel({ webhookUrl: "https://test" });
    const longMsg = "x".repeat(2000);
    const embed = ch._buildEmbed("session_error", { message: longMsg });
    const msgField = embed.fields.find(f => f.name === "Message");
    expect(msgField.value.length).toBeLessThanOrEqual(1024);
  });
});

describe("NotificationEvents", () => {
  it("has all required event constants", () => {
    expect(NotificationEvents.PROPOSAL_CREATED).toBe("proposal_created");
    expect(NotificationEvents.PROPOSAL_APPROVED).toBe("proposal_approved");
    expect(NotificationEvents.PROPOSAL_REJECTED).toBe("proposal_rejected");
    expect(NotificationEvents.SESSION_CONNECTED).toBe("session_connected");
    expect(NotificationEvents.SESSION_ERROR).toBe("session_error");
    expect(NotificationEvents.CHAT_COMPLETED).toBe("chat_completed");
  });
});
