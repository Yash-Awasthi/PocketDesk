/**
 * Remote desktop bridge — session-scoped view and control of this PC's screen.
 *
 * Frames and input are real: every session is backed by the DesktopController
 * (screen capture + SendInput injection). The manager owns the per-session
 * bookkeeping the protocol exposes — quality presets, frame buffers, activity
 * timestamps — and translates client coordinates back to desktop pixels,
 * because frames are downscaled by the quality preset before they go out.
 *
 * Without a controller, or on a platform the controller does not support,
 * sessions still exist but frames and input report unsupported_platform.
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

/** Quality preset → capture quality, frame rate and downscale factor. */
const PRESETS = {
  low: { capture: 30, fps: 3, scale: 0.5 },
  medium: { capture: 60, fps: 3, scale: 0.75 },
  high: { capture: 80, fps: 3, scale: 1 },
  ultra: { capture: 95, fps: 3, scale: 1 },
};

export class RemoteDesktopBridgeManager extends EventEmitter {
  /** @param {{ startFrameStream:Function, stopFrameStream:Function, getFrame:Function, setQuality:Function, inputMouse:Function, inputKey:Function, inputType:Function, on:Function, constructor:any }|null} controller */
  constructor(controller = null) {
    super();
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, object[]>} */
    this.frameBuffers = new Map();
    this.controller = controller;
    this.stats = { framesServed: 0, inputsForwarded: 0 };

    controller?.on?.("frame", (frame) => this._fanout(frame));
  }

  get supported() {
    return !!this.controller && this.controller.constructor.supported !== false;
  }

  _fanout(frame) {
    for (const session of this.sessions.values()) {
      if (session.status !== "connected") continue;
      session.lastActivity = new Date();
      session.resolution = { width: frame.width, height: frame.height };
      const buffer = this.frameBuffers.get(session.id) || [];
      buffer.push({ seq: frame.seq, timestamp: frame.ts, width: frame.width, height: frame.height });
      while (buffer.length > 30) buffer.shift();
      this.frameBuffers.set(session.id, buffer);
      this.stats.framesServed++;
      this.emit("frame:received", { sessionId: session.id, frameNumber: frame.seq, timestamp: frame.ts, width: frame.width, height: frame.height });
    }
  }

  /** Create a session and start the capture loop that feeds it. */
  async createSession(hostName, hostIp, quality = "medium") {
    const preset = PRESETS[quality] || PRESETS.medium;
    const session = {
      id: randomBytes(16).toString("hex"),
      hostName,
      hostIp,
      status: "connecting",
      connectedAt: new Date(),
      lastActivity: new Date(),
      resolution: { width: 0, height: 0 },
      fps: preset.fps,
      bandwidth: 0,
      isEncrypted: true,
      quality,
      supported: this.supported,
    };
    this.sessions.set(session.id, session);
    this.frameBuffers.set(session.id, []);

    const started = this.controller ? await this.controller.startFrameStream(session.id, preset.capture) : { ok: false, reason: "no_controller" };
    session.status = "connected";
    if (!started.ok) session.reason = started.reason;
    this.emit("session:connected", session);
    return session;
  }

  /** Latest captured frame for a session (captures one if the loop has none). */
  async getFrame(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "connected") return { ok: false, reason: "no_session" };
    if (!this.controller) return { ok: false, reason: "no_controller" };
    const frame = await this.controller.getFrame();
    if (!frame.ok) return frame;
    session.lastActivity = new Date();
    session.resolution = { width: frame.width, height: frame.height };
    return frame;
  }

  /**
   * Forward an input event to the real desktop. Client coordinates are in
   * downscaled frame space, so they are divided back by the preset scale.
   */
  async sendInput(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "connected") return { ok: false, reason: "no_session" };
    if (!this.controller) return { ok: false, reason: "no_controller" };

    session.lastActivity = new Date();
    const scale = (PRESETS[session.quality] || PRESETS.medium).scale;
    const x = Math.round(Number(event.x || 0) / scale);
    const y = Math.round(Number(event.y || 0) / scale);

    let result;
    switch (event.type) {
      case "mouse_move":
        result = await this.controller.inputMouse({ x, y });
        break;
      case "mouse_click":
        result = await this.controller.inputMouse({ x, y, click: true, button: Number(event.button) || 0 });
        break;
      case "mouse_wheel":
        result = await this.controller.inputMouse({ x, y, wheel: Number(event.wheel) || 0 });
        break;
      case "key_press":
        result = await this.controller.inputKey({ key: event.key, modifiers: event.modifiers || [] });
        break;
      case "text":
        result = await this.controller.inputType(String(event.text ?? ""));
        break;
      default:
        return { ok: false, reason: "bad_input_type" };
    }
    if (result.ok) this.stats.inputsForwarded++;
    this.emit("input:forwarded", { sessionId, event, ok: !!result.ok, timestamp: Date.now() });
    return result;
  }

  /** Apply a quality preset (also retunes the capture helper). */
  updateQuality(sessionId, quality) {
    const session = this.sessions.get(sessionId);
    const preset = PRESETS[quality];
    if (!session || !preset) return false;
    session.quality = quality;
    session.fps = preset.fps;
    this.controller?.setQuality(preset.capture);
    this.emit("quality:updated", { sessionId, quality });
    return true;
  }

  /** Disconnect a session and release its share of the capture loop. */
  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = "disconnected";
    this.frameBuffers.delete(sessionId);
    this.controller?.stopFrameStream(sessionId);
    this.emit("session:disconnected", session);
    return true;
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter((s) => s.status === "connected");
  }

  getStats() {
    return {
      supported: this.supported,
      totalSessions: this.sessions.size,
      activeSessions: this.getActiveSessions().length,
      ...this.stats,
    };
  }
}
