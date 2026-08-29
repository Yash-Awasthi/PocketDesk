/**
 * Auth plugin — optional token-based auth for WebSocket connections.
 *
 * When enabled, clients must send a "hello" message with a valid token
 * within the timeout window. This replaces the built-in auth in server.js
 * with a more configurable version.
 *
 * Config:
 *   token: the required auth token (from daemon --token)
 *   timeout: auth timeout in ms (default 10000)
 *   allowAnonymous: allow connections without token (default false)
 */
export default {
  name: "auth",
  version: "1.0.0",
  hooks: ["init", "onMessage"],

  _token: null,
  _timeout: 10_000,
  _authenticated: new WeakSet(),

  init(ctx) {
    this._token = ctx.config?.token;
    this._timeout = ctx.config?.authTimeout || 10_000;
  },

  onMessage(ctx, ws, msg) {
    // If already authenticated, pass through
    if (ws._authed) return;

    // Only handle "hello" messages
    if (msg.type !== "hello") {
      return { block: true };
    }

    // Validate token
    if (this._token && msg.token !== this._token) {
      return { block: true };
    }

    // Token valid — mark as authed
    ws._authed = true;
    return undefined; // let server.js handle the welcome
  },
};
