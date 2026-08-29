/**
 * Metrics plugin — collects session metrics.
 *
 * Tracks: message count, session uptime, connection count,
 * chat messages, file operations. Exposes /metrics endpoint.
 */
export default {
  name: "metrics",
  version: "1.0.0",
  hooks: ["init", "start", "onConnect", "onDisconnect", "onMessage", "onSessionCreated", "onSessionExit"],

  _counts: {
    messages: 0,
    connections: 0,
    disconnects: 0,
    sessionsCreated: 0,
    sessionsExited: 0,
    chatMessages: 0,
    fileOps: 0,
    errors: 0,
  },
  _startTime: null,
  _sessionStarts: new Map(),

  init() {
    this._startTime = Date.now();
  },

  start(ctx) {
    // Register /metrics HTTP endpoint if possible
    // (server.js will need to route this — or plugins can modify the handler)
  },

  onConnect() {
    this._counts.connections++;
  },

  onDisconnect() {
    this._counts.disconnects++;
  },

  onMessage(ctx, ws, msg) {
    this._counts.messages++;
    if (msg.type === "chatmsg" || msg.type === "chatcancel") this._counts.chatMessages++;
    if (msg.type === "fread" || msg.type === "fwrite" || msg.type === "fs") this._counts.fileOps++;
    if (msg.type === "in" || msg.type === "resize") {} // terminal I/O — don't count separately
  },

  onSessionCreated(ctx, session) {
    this._counts.sessionsCreated++;
    this._sessionStarts.set(session.id, Date.now());
  },

  onSessionExit(ctx, session) {
    this._counts.sessionsExited++;
    const start = this._sessionStarts.get(session.id);
    if (start) this._sessionStarts.delete(session.id);
  },

  /**
   * Get current metrics snapshot. Call from server.js or HTTP endpoint.
   */
  getMetrics() {
    const uptimeMs = Date.now() - this._startTime;
    return {
      uptime_seconds: Math.floor(uptimeMs / 1000),
      uptime_human: formatDuration(uptimeMs),
      ...this._counts,
      active_sessions: this._sessionStarts.size,
    };
  },
};

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
