/**
 * chat-tag — a reference PocketDesk plugin.
 *
 * Prefixes every chat message with a configurable tag and blocks empty ones.
 * Not auto-loaded: discovery only scans daemon/src/plugins/*.js. Copy this
 * directory there (or call the manager's register() yourself) to enable it.
 *
 * Config:
 *   tag: text prepended to each chat message; defaults to "[tag]".
 */
export default {
  name: "chat-tag",
  version: "1.0.0",
  hooks: ["init", "onMessage"],

  _tag: "[tag]",

  init(ctx) {
    this._tag = ctx.config?.tag || "[tag]";
  },

  onMessage(_ctx, _ws, msg) {
    if (msg.type !== "chatmsg") return undefined;
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim()) return { block: true };
    return { modify: { ...msg, text: `${this._tag} ${text}` } };
  },
};
