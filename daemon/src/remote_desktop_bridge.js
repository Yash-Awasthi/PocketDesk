/**
 * Remote Desktop Bridge — Control desktop applications from mobile devices.
 *
 * Inspired by remodex-android and rustdesk.
 * Provides screen streaming, input forwarding, and file transfer
 * for remote desktop control.
 *
 * NOTE: ported from TS-syntax-in-.js to plain ESM (it could not be imported
 * under the package's "type": "module" before).
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Remote-desktop session manager: session lifecycle, frame buffering,
 * input forwarding, and file-transfer simulation.
 */
export class RemoteDesktopBridgeManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, object[]>} */
    this.frameBuffers = new Map();
    /** @type {Map<string, object>} */
    this.fileTransfers = new Map();
  }

  /**
   * Create a new desktop session (connects asynchronously).
   */
  createSession(hostName, hostIp, quality = "medium") {
    const session = {
      id: randomBytes(16).toString("hex"),
      hostName,
      hostIp,
      status: "connecting",
      connectedAt: new Date(),
      lastActivity: new Date(),
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      bandwidth: 0,
      isEncrypted: true,
      quality,
    };

    this.sessions.set(session.id, session);
    this.frameBuffers.set(session.id, []);

    // Simulate connection
    setTimeout(() => {
      session.status = "connected";
      this.emit("session:connected", session);
    }, 500);

    return session;
  }

  /**
   * Process a screen frame (buffers the last 30 per session).
   */
  processFrame(sessionId, frame) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "connected") return;

    session.lastActivity = new Date();

    const buffer = this.frameBuffers.get(sessionId) || [];
    buffer.push(frame);

    while (buffer.length > 30) {
      buffer.shift();
    }
    this.frameBuffers.set(sessionId, buffer);

    this.emit("frame:received", {
      sessionId,
      frameNumber: frame.frameNumber,
      timestamp: frame.timestamp,
    });
  }

  /**
   * Send an input event to the remote desktop.
   */
  sendInput(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "connected") return false;

    session.lastActivity = new Date();

    this.emit("input:forwarded", {
      sessionId,
      event,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Start a file transfer (simulated progress).
   */
  startFileTransfer(sessionId, filename, size, direction) {
    const transfer = {
      id: randomBytes(8).toString("hex"),
      sessionId,
      filename,
      size,
      direction,
      progress: 0,
      status: "pending",
    };

    this.fileTransfers.set(transfer.id, transfer);

    transfer.status = "transferring";
    const interval = setInterval(() => {
      transfer.progress += 10;
      if (transfer.progress >= 100) {
        transfer.progress = 100;
        transfer.status = "completed";
        clearInterval(interval);
        this.emit("transfer:completed", transfer);
      }
      this.emit("transfer:progress", { transferId: transfer.id, progress: transfer.progress });
    }, 100);

    return transfer;
  }

  /**
   * Update session quality (adjusts fps/resolution presets).
   */
  updateQuality(sessionId, quality) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.quality = quality;

    switch (quality) {
      case "low":
        session.fps = 15;
        session.resolution = { width: 640, height: 480 };
        break;
      case "medium":
        session.fps = 30;
        session.resolution = { width: 1280, height: 720 };
        break;
      case "high":
        session.fps = 60;
        session.resolution = { width: 1920, height: 1080 };
        break;
      case "ultra":
        session.fps = 120;
        session.resolution = { width: 2560, height: 1440 };
        break;
    }

    this.emit("quality:updated", { sessionId, quality });
    return true;
  }

  /**
   * Disconnect a session and drop its frame buffer.
   */
  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = "disconnected";
    this.frameBuffers.delete(sessionId);
    this.emit("session:disconnected", session);
    return true;
  }

  /**
   * Get all connected sessions.
   */
  getActiveSessions() {
    return Array.from(this.sessions.values()).filter((s) => s.status === "connected");
  }

  /**
   * Get file transfers for a session.
   */
  getSessionTransfers(sessionId) {
    return Array.from(this.fileTransfers.values()).filter((t) => t.sessionId === sessionId);
  }

  /**
   * Get statistics.
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter((s) => s.status === "connected").length,
      totalTransfers: this.fileTransfers.size,
      activeTransfers: Array.from(this.fileTransfers.values()).filter((t) => t.status === "transferring").length,
    };
  }
}
