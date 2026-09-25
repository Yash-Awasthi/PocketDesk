/**
 * Logger plugin — logs all WebSocket events with timestamps.
 *
 * Useful for debugging and audit trails.
 */
import fs from "node:fs";
import path from "node:path";

const NOISY = new Set(["video_ack", "desktop_mouse", "desktop_key", "desktop_type"]);

export default {
  name: "logger",
  version: "1.0.0",
  hooks: ["init", "start", "stop", "onConnect", "onDisconnect", "onMessage"],

  _stream: null,
  _dir: null,

  init(ctx) {
    this._dir = path.join(ctx.config?.dataDir || ".pocketdesk", "logs");
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });
  },

  start(ctx) {
    const logFile = path.join(this._dir, `daemon-${new Date().toISOString().slice(0, 10)}.log`);
    this._stream = fs.createWriteStream(logFile, { flags: "a" });
    this._log("start", { port: ctx.config?.port });
  },

  stop() {
    this._log("stop", {});
    if (this._stream) { this._stream.end(); this._stream = null; }
  },

  onConnect(ctx, ws) {
    this._log("connect", { remote: ws._remote });
  },

  onDisconnect(ctx, ws) {
    this._log("disconnect", { remote: ws._remote });
  },

  onMessage(ctx, ws, msg) {
    // Input and video acks arrive several times a second and would bury everything else.
    if (NOISY.has(msg.type)) return;
    this._log("message", { type: msg.type, remote: ws._remote });
  },

  _log(event, data) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    if (this._stream) this._stream.write(line);
    process.stdout.write(`[logger] ${event} ${JSON.stringify(data)}\n`);
  },
};
