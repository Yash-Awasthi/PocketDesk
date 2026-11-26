/**
 * Logger plugin: every WebSocket event, one JSON line each, in the profile's
 * logs folder. Format, location, redaction and rotation live in logbook.js so
 * nothing else grows its own log file.
 */
import fs from "node:fs";
import * as logbook from "../logbook.js";

const NOISY = new Set(["video_ack", "desktop_mouse", "desktop_key", "desktop_type"]);

export default {
  name: "logger",
  version: "1.1.0",
  hooks: ["init", "start", "stop", "onConnect", "onDisconnect", "onMessage", "onRefused"],

  _dir: null,
  _file: null,

  init(ctx) {
    // Under the profile like every other data file; cwd-relative landed logs inside the install dir.
    this._dir = logbook.logDir(ctx.config?.dataDir);
    fs.mkdirSync(this._dir, { recursive: true, mode: 0o700 });
  },

  start(ctx) {
    this._file = logbook.dailyFile(this._dir);
    this._log("start", { port: ctx.config?.port });
  },

  stop() {
    this._log("stop", {});
    this._file = null;
  },

  onConnect(_ctx, ws) {
    this._log("connect", { remote: ws._remote });
  },

  onDisconnect(_ctx, ws) {
    this._log("disconnect", { remote: ws._remote });
  },

  onMessage(_ctx, ws, msg) {
    // Input and video acks arrive several times a second and would bury everything else.
    if (NOISY.has(msg.type)) return;
    this._log("message", { type: msg.type, remote: ws._remote });
  },

  onRefused(_ctx, ws, refusal) {
    this._log("refused", { type: refusal.type, key: refusal.key, remote: ws._remote });
  },

  _log(event, data) {
    const line = logbook.record(event, data);
    try {
      if (this._file) logbook.appendLine(this._file, line);
    } catch {
      /* a full disk must not stop the daemon */
    }
    process.stdout.write(line);
  },
};
