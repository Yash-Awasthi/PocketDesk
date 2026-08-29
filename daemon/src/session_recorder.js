/**
 * SessionRecorder - Terminal session recording and replay
 * Inspired by termpair's session recording and ttyd's output capture
 * 
 * Records terminal sessions with timestamps, output capture,
 * and supports replay with variable speed.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

class SessionRecorder extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.maxSessions = 100;
    this.maxEventsPerSession = 10000;
  }

  startRecording(sessionId) {
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }

    const session = {
      id: sessionId || crypto.randomUUID(),
      startTime: Date.now(),
      events: [],
      metadata: {
        userAgent: null,
        terminalSize: null,
        cwd: null,
      },
      isRecording: true,
      pausedAt: null,
      totalPauseDuration: 0,
    };

    this.sessions.set(session.id, session);
    this.emit('recording-started', { sessionId: session.id });
    return session.id;
  }

  stopRecording(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.isRecording = false;
    session.endTime = Date.now();
    session.duration = session.endTime - session.startTime - session.totalPauseDuration;
    session.eventCount = session.events.length;

    this.emit('recording-stopped', { 
      sessionId, 
      duration: session.duration,
      eventCount: session.eventCount 
    });

    return this._summarize(session);
  }

  pauseRecording(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRecording) return false;
    session.isRecording = false;
    session.pausedAt = Date.now();
    return true;
  }

  resumeRecording(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.pausedAt === null) return false;
    session.totalPauseDuration += Date.now() - session.pausedAt;
    session.isRecording = true;
    session.pausedAt = null;
    return true;
  }

  recordInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRecording) return;

    if (session.events.length >= this.maxEventsPerSession) {
      session.events.shift();
    }

    session.events.push({
      type: 'input',
      timestamp: Date.now() - session.startTime - session.totalPauseDuration,
      data: typeof data === 'string' ? data : data.toString('utf-8'),
    });
  }

  recordOutput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRecording) return;

    if (session.events.length >= this.maxEventsPerSession) {
      session.events.shift();
    }

    const str = typeof data === 'string' ? data : data.toString('utf-8');
    const lastEvent = session.events[session.events.length - 1];

    if (lastEvent?.type === 'output' && (Date.now() - session.startTime - lastEvent.timestamp) < 16) {
      lastEvent.data += str;
      lastEvent.size = lastEvent.data.length;
    } else {
      session.events.push({
        type: 'output',
        timestamp: Date.now() - session.startTime - session.totalPauseDuration,
        data: str,
        size: str.length,
      });
    }
  }

  recordResize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRecording) return;

    session.metadata.terminalSize = { cols, rows };
    session.events.push({
      type: 'resize',
      timestamp: Date.now() - session.startTime - session.totalPauseDuration,
      data: { cols, rows },
    });
  }

  recordMetadata(sessionId, key, value) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata[key] = value;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this._summarize(session);
  }

  listSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({
        id,
        startTime: session.startTime,
        endTime: session.endTime,
        duration: session.duration,
        eventCount: session.events.length,
        isRecording: session.isRecording,
      });
    }
    return list.sort((a, b) => b.startTime - a.startTime);
  }

  getEvents(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    let events = [...session.events];
    const { startTime, endTime, type, limit } = options;

    if (startTime !== undefined) events = events.filter(e => e.timestamp >= startTime);
    if (endTime !== undefined) events = events.filter(e => e.timestamp <= endTime);
    if (type) events = events.filter(e => e.type === type);
    if (limit) events = events.slice(-limit);

    return events;
  }

  exportSession(sessionId, format = 'json') {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const data = {
      id: session.id,
      startTime: session.startTime,
      endTime: session.endTime || Date.now(),
      duration: session.duration || (Date.now() - session.startTime - session.totalPauseDuration),
      metadata: session.metadata,
      events: session.events,
    };

    if (format === 'json') return JSON.stringify(data, null, 2);
    if (format === 'text') return this._exportAsText(session);
    if (format === 'html') return this._exportAsHtml(session);
    return data;
  }

  deleteSession(sessionId) {
    return this.sessions.delete(sessionId);
  }

  _exportAsText(session) {
    let output = `Session: ${session.id}\n`;
    output += `Started: ${new Date(session.startTime).toISOString()}\n`;
    output += `Duration: ${session.duration || 0}ms\n`;
    output += `${'='.repeat(60)}\n\n`;

    for (const event of session.events) {
      if (event.type === 'input') {
        output += `> ${event.data}\n`;
      } else if (event.type === 'output') {
        output += event.data;
      }
    }

    return output;
  }

  _exportAsHtml(session) {
    let html = `<!DOCTYPE html><html><head><title>Session ${session.id}</title>`;
    html += `<style>body{background:#1a1a2e;color:#e0e0e0;font-family:monospace;padding:20px;}`;
    html += `.input{color:#00ff88;}.output{color:#e0e0e0;}.timestamp{color:#666;font-size:12px;}`;
    html += `.resize{color:#ffaa00;font-style:italic;}</style></head><body>`;
    html += `<h2>Session: ${session.id}</h2>`;
    html += `<p>Duration: ${session.duration || 0}ms | Events: ${session.events.length}</p><hr>`;

    for (const event of session.events) {
      const ts = `<span class="timestamp">[${event.timestamp}ms]</span> `;
      if (event.type === 'input') {
        html += `${ts}<span class="input">&gt; ${this._escapeHtml(event.data)}</span><br>`;
      } else if (event.type === 'output') {
        html += `${ts}<span class="output">${this._escapeHtml(event.data)}</span>`;
      } else if (event.type === 'resize') {
        html += `${ts}<span class="resize">Terminal resized to ${event.data.cols}x${event.data.rows}</span><br>`;
      }
    }

    html += `</body></html>`;
    return html;
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _summarize(session) {
    return {
      id: session.id,
      startTime: session.startTime,
      endTime: session.endTime,
      duration: session.duration || (Date.now() - session.startTime - session.totalPauseDuration),
      eventCount: session.events.length,
      isRecording: session.isRecording,
      metadata: session.metadata,
      totalPauseDuration: session.totalPauseDuration,
    };
  }
}

class SessionReplayer extends EventEmitter {
  constructor(recorder) {
    super();
    this.recorder = recorder;
    this.replays = new Map();
  }

  startReplay(sessionId, options = {}) {
    const events = this.recorder.getEvents(sessionId);
    if (!events.length) return null;

    const { speed = 1, startTime, endTime, skipInput = false } = options;
    let filteredEvents = events;

    if (startTime !== undefined) filteredEvents = filteredEvents.filter(e => e.timestamp >= startTime);
    if (endTime !== undefined) filteredEvents = filteredEvents.filter(e => e.timestamp <= endTime);
    if (skipInput) filteredEvents = filteredEvents.filter(e => e.type !== 'input');

    const replayId = crypto.randomUUID();
    const replay = {
      id: replayId,
      sessionId,
      events: filteredEvents,
      speed,
      currentIndex: 0,
      isPlaying: false,
      startedAt: null,
    };

    this.replays.set(replayId, replay);
    return replayId;
  }

  play(replayId) {
    const replay = this.replays.get(replayId);
    if (!replay || replay.isPlaying) return false;

    replay.isPlaying = true;
    replay.startedAt = Date.now();
    this._emitNext(replay);
    return true;
  }

  pause(replayId) {
    const replay = this.replays.get(replayId);
    if (!replay) return false;
    replay.isPlaying = false;
    if (replay.timer) clearTimeout(replay.timer);
    return true;
  }

  stop(replayId) {
    const replay = this.replays.get(replayId);
    if (!replay) return false;
    replay.isPlaying = false;
    if (replay.timer) clearTimeout(replay.timer);
    this.replays.delete(replayId);
    return true;
  }

  _emitNext(replay) {
    if (!replay.isPlaying || replay.currentIndex >= replay.events.length) {
      replay.isPlaying = false;
      this.emit('replay-ended', { replayId: replay.id });
      return;
    }

    const event = replay.events[replay.currentIndex];
    const nextEvent = replay.events[replay.currentIndex + 1];
    
    this.emit('replay-event', {
      replayId: replay.id,
      event,
      progress: (replay.currentIndex + 1) / replay.events.length,
      remaining: replay.events.length - replay.currentIndex - 1,
    });

    replay.currentIndex++;

    if (nextEvent) {
      const delay = (nextEvent.timestamp - event.timestamp) / replay.speed;
      replay.timer = setTimeout(() => this._emitNext(replay), Math.max(1, delay));
    } else {
      replay.isPlaying = false;
      this.emit('replay-ended', { replayId: replay.id });
    }
  }

  getProgress(replayId) {
    const replay = this.replays.get(replayId);
    if (!replay) return null;
    return {
      currentIndex: replay.currentIndex,
      total: replay.events.length,
      progress: replay.events.length ? replay.currentIndex / replay.events.length : 1,
      isPlaying: replay.isPlaying,
      speed: replay.speed,
    };
  }
}

module.exports = { SessionRecorder, SessionReplayer };
