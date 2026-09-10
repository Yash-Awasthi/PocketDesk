/**
 * Telegram Two-Way Control — drive the harness from a Telegram chat.
 *
 * Absorbed from telegram_claude-cli-telegram / whatsapp-claude-plugin
 * (two-way chat-channel control with per-chat-user allowlist).
 *
 * Outbound notifications already exist (channels/telegram.js); this adds the
 * inbound leg: long-polls getUpdates and routes allow-listed senders' commands
 * to the daemon. Disabled unless TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOW_CHAT_IDS
 * are set. Plain text goes to the newest chat session as a prompt.
 */

export function startTelegramControl({ token, allowChatIds, handlers, apiBase } = {}) {
  if (!token || !allowChatIds?.length) return { stop() {} };
  const base = apiBase || `https://api.telegram.org/bot${token}`;
  const allowed = new Set(allowChatIds.map(String));
  let offset = 0;
  let stopped = false;
  let timer = null;

  async function call(method, body) {
    const resp = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method} failed: ${JSON.stringify(json).slice(0, 200)}`);
    return json.result;
  }

  async function reply(chatId, text) {
    try {
      await call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
    } catch (e) {
      console.error(`[telegram-control] reply failed: ${e.message}`);
    }
  }

  async function handleUpdate(u) {
    const msg = u.message || u.edited_message;
    const text = String(msg?.text || "").trim();
    const chatId = String(msg?.chat?.id || "");
    if (!text || !chatId) return;
    if (!allowed.has(chatId)) {
      console.log(`[telegram-control] ignored message from unallowed chat ${chatId}`);
      return;
    }
    try {
      await route(chatId, text);
    } catch (e) {
      await reply(chatId, `⚠️ ${e.message}`);
    }
  }

  async function route(chatId, text) {
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd.toLowerCase()) {
        case "sessions": {
          const items = handlers.listSessions();
          await reply(chatId, items.length
            ? items.map((s) => `${s.id} [${s.harnessId}] ${s.state || s.kind || ""} ${s.cwd || ""}`).join("\n")
            : "No active sessions.");
          return;
        }
        case "say": {
          const [id, ...msg] = rest;
          const ok = handlers.say(id, msg.join(" "));
          await reply(chatId, ok ? `Sent to ${id}.` : `No such chat: ${id}`);
          return;
        }
        case "approvals": {
          const items = handlers.listProposals();
          await reply(chatId, items.length
            ? items.map((p) => `${p.id} — ${p.summary}`).join("\n")
            : "No pending proposals.");
          return;
        }
        case "approve":
        case "reject": {
          if (!rest[0]) return reply(chatId, `Usage: /${cmd} <proposal-id>`);
          const p = handlers.decide(rest[0], cmd.toLowerCase() === "approve");
          await reply(chatId, p ? `${cmd}d ${rest[0]}.` : `Proposal ${rest[0]} not found or already decided.`);
          return;
        }
        case "help":
        default:
          await reply(chatId, [
            "*PocketDesk commands*",
            "/sessions — list live sessions",
            "/say <id> <text> — prompt a chat session",
            "/approvals — pending proposals",
            "/approve <id> | /reject <id>",
            "plain text — prompt the newest chat session",
          ].join("\n"));
          return;
      }
    }
    // Plain text → newest chat session (claude-cli-telegram "just type" pattern).
    const target = handlers.newestChat();
    if (!target) return reply(chatId, "No chat session to prompt. Create one from the app first.");
    const ok = handlers.say(target, text);
    await reply(chatId, ok ? `→ ${target}` : `No such chat: ${target}`);
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await call("getUpdates", { timeout: 25, offset });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u);
        }
      } catch (e) {
        if (stopped) return;
        console.error(`[telegram-control] poll error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  console.log("  telegram-control: two-way control enabled");
  poll();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
