/**
 * Agent Orchestrator - Multi-agent session management.
 * Extracted from 1code (inspiration).
 * Manages multiple coding agents, worktrees, and background sandboxes.
 */

import { EventEmitter } from 'events';

export class AgentType {
  static CLAUDE = 'claude';
  static CODEX = 'codex';
  static GEMINI = 'gemini';
  static CUSTOM = 'custom';
}

export class AgentStatus {
  static IDLE = 'idle';
  static RUNNING = 'running';
  static PAUSED = 'paused';
  static ERROR = 'error';
  static COMPLETED = 'completed';
}

export class AgentSession {
  constructor(config) {
    this.id = config.id || `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.agentType = config.agentType || AgentType.CLAUDE;
    this.status = AgentStatus.IDLE;
    this.worktreePath = config.worktreePath || null;
    this.systemPrompt = config.systemPrompt || '';
    this.model = config.model || null;
    this.apiKey = config.apiKey || null;
    this.messages = [];
    this.toolsUsed = [];
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.error = null;
    this.metadata = config.metadata || {};
  }

  addMessage(role, content) {
    this.messages.push({ role, content, timestamp: new Date() });
    this.updatedAt = new Date();
  }

  recordToolUse(toolName, args, result) {
    this.toolsUsed.push({ toolName, args, result, timestamp: new Date() });
    this.updatedAt = new Date();
  }

  toJSON() {
    return {
      id: this.id,
      agentType: this.agentType,
      status: this.status,
      worktreePath: this.worktreePath,
      messageCount: this.messages.length,
      toolsUsedCount: this.toolsUsed.length,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      error: this.error,
      metadata: this.metadata,
    };
  }
}

export class WorktreeManager {
  constructor(basePath = '/tmp/pocketdesk-worktrees') {
    this.basePath = basePath;
    this.worktrees = new Map();
  }

  async create(name) {
    const path = `${this.basePath}/${name}_${Date.now()}`;
    this.worktrees.set(name, { path, createdAt: new Date(), active: true });
    return path;
  }

  async remove(name) {
    const wt = this.worktrees.get(name);
    if (wt) {
      wt.active = false;
      this.worktrees.delete(name);
    }
  }

  list() {
    return Array.from(this.worktrees.entries()).map(([name, info]) => ({
      name,
      ...info,
    }));
  }

  get(name) {
    return this.worktrees.get(name) || null;
  }
}

export class AgentOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.sessions = new Map();
    this.worktreeManager = new WorktreeManager(config.worktreeBasePath);
    this.maxConcurrent = config.maxConcurrent || 5;
    this.activeCount = 0;
  }

  async createSession(config) {
    const session = new AgentSession(config);
    this.sessions.set(session.id, session);
    this.emit('session:created', session.toJSON());
    return session;
  }

  async startSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error('Max concurrent sessions reached');
    }
    session.status = AgentStatus.RUNNING;
    this.activeCount++;
    this.emit('session:started', session.toJSON());
    return session;
  }

  async pauseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = AgentStatus.PAUSED;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.emit('session:paused', session.toJSON());
    return session;
  }

  async resumeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error('Max concurrent sessions reached');
    }
    session.status = AgentStatus.RUNNING;
    this.activeCount++;
    this.emit('session:resumed', session.toJSON());
    return session;
  }

  async completeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = AgentStatus.COMPLETED;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.emit('session:completed', session.toJSON());
    return session;
  }

  async errorSession(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = AgentStatus.ERROR;
    session.error = error;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.emit('session:error', session.toJSON());
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  listSessions(filter = {}) {
    let sessions = Array.from(this.sessions.values());
    if (filter.status) sessions = sessions.filter((s) => s.status === filter.status);
    if (filter.agentType) sessions = sessions.filter((s) => s.agentType === filter.agentType);
    return sessions.map((s) => s.toJSON());
  }

  getStats() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      active: sessions.filter((s) => s.status === AgentStatus.RUNNING).length,
      paused: sessions.filter((s) => s.status === AgentStatus.PAUSED).length,
      completed: sessions.filter((s) => s.status === AgentStatus.COMPLETED).length,
      errored: sessions.filter((s) => s.status === AgentStatus.ERROR).length,
      byType: sessions.reduce((acc, s) => {
        acc[s.agentType] = (acc[s.agentType] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  async broadcast(message, excludeSessionId = null) {
    for (const [id, session] of this.sessions) {
      if (id !== excludeSessionId && session.status === AgentStatus.RUNNING) {
        session.addMessage('system', message);
        this.emit('session:broadcast', { sessionId: id, message });
      }
    }
  }

  destroy() {
    this.sessions.clear();
    this.activeCount = 0;
    this.removeAllListeners();
  }
}
