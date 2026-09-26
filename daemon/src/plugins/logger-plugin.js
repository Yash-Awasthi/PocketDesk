/**
 * Logger plugin — logs all WebSocket events with timestamps.
 *
 * Useful for debugging and audit trails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOISY = new Set(["video_ack", "desktop_mouse", "desktop_key", "desktop_type"]);

export default {
  name: "logger",
  version: "1.0.0",
  hooks: ["init", "start", "stop", "onConnect", "onDisconnect", "onMessage"],

  _stream: null,
  _dir: null,

  init(ctx) {
    // Under the profile like every other data file; cwd-relative landed logs inside the install dir.
    this._dir = path.join(os.homedir(), ctx.config?.dataDir || ".pocketdesk", "logs");
    fs.mkdirSync(this._dir, { recursive: true, mode: 0o700 });
  },

  start(ctx) {
    const logFile = path.join(this._dir, `daemon-${new Date().toISOString().slice(0, 10)}.log`);
    this._stream = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
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
