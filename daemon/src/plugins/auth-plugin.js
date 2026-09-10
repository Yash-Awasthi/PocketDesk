/**
 * Auth plugin — early gate in front of the built-in handshake in server.js.
 *
 * Blocks pre-auth traffic before it reaches the server handler. The hello →
 * welcome exchange itself stays with server.js (constant-time compare, rate
 * limiting, close codes) — this plugin never marks the socket authed.
 *
 * Config:
 *   token: the required auth token (from daemon --token)
 */
export default {
  name: "auth",
  version: "1.0.0",
  hooks: ["init", "onMessage"],

  _token: null,

  init(ctx) {
    this._token = ctx.config?.token;
  },

  onMessage(ctx, ws, msg) {
    if (ws._authed) return; // post-auth: pass through
    if (msg.type !== "hello") return { block: true }; // nothing leaks pre-auth
    // Wrong-token hellos MUST reach server.js: it owns the close contract
    // (4003 bad token, 4029 rate limit) that clients depend on.
    return undefined;
  },
};
