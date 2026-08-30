/**
 * AI Agent Session Manager for PocketDesk
 * Extracted from: conch (Android client for Claude Code, Codex, Gemini CLI)
 * Patterns: Multi-agent session management, SSH tunneling, chat interface,
 *           session persistence, appearance customization, telemetry-free design
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class AIAgentManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.agents = new Map();
    this.chatHistory = new Map();
    this.activeAgent = null;
  }

  // ─── Agent Registry ────────────────────────────────────────────────

  registerAgent(config) {
    const id = config.id || crypto.randomUUID();
    const agent = {
      id,
      name: config.name,
      type: config.type, // 'claude-code', 'codex', 'gemini', 'copilot', 'grok'
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      icon: config.icon || '🤖',
      color: config.color || '#4CAF50',
      enabled: config.enabled !== false,
      capabilities: config.capabilities || ['chat', 'execute', 'read', 'write'],
    };
    this.agents.set(id, agent);
    this.emit('agent:registered', agent);
    return agent;
  }

  listAgents() {
    return Array.from(this.agents.values()).filter(a => a.enabled);
  }

  getAgent(id) {
    return this.agents.get(id);
  }

  // ─── Session Management ────────────────────────────────────────────

  createSession(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      agentId,
      agentName: agent.name,
      name: options.name || `Session ${sessionId.slice(0, 8)}`,
      status: 'idle',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messages: [],
      cwd: options.cwd || process.cwd(),
      environment: { ...agent.env, ...options.env },
      worktree: options.worktree,
      model: options.model,
    };

    this.sessions.set(sessionId, session);
    this.chatHistory.set(sessionId, []);
    this.emit('session:created', session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions(filter = {}) {
    let sessions = Array.from(this.sessions.values());
    if (filter.agentId) sessions = sessions.filter(s => s.agentId === filter.agentId);
    if (filter.status) sessions = sessions.filter(s => s.status === filter.status);
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  switchSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    this.activeAgent = sessionId;
    this.emit('session:switched', session);
    return session;
  }

  deleteSession(sessionId) {
    this.sessions.delete(sessionId);
    this.chatHistory.delete(sessionId);
    this.emit('session:deleted', { sessionId });
  }

  renameSession(sessionId, name) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.name = name;
    this.emit('session:renamed', session);
    return session;
  }

  // ─── Chat Interface ────────────────────────────────────────────────

  async sendMessage(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.status = 'thinking';
    session.lastActivity = Date.now();

    const chatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: options.attachments || [],
    };

    this.chatHistory.get(sessionId).push(chatMessage);
    this.emit('message:sent', { sessionId, message: chatMessage });

    // Simulate agent processing
    session.status = 'running';
    this.emit('session:processing', session);

    return chatMessage;
  }

  receiveMessage(sessionId, content, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const chatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      agentName: session.agentName,
      toolCalls: options.toolCalls || [],
      thinkingTime: options.thinkingTime || 0,
    };

    this.chatHistory.get(sessionId).push(chatMessage);
    session.status = 'idle';
    session.lastActivity = Date.now();

    this.emit('message:received', { sessionId, message: chatMessage });
    return chatMessage;
  }

  getChatHistory(sessionId, limit = 50) {
    const history = this.chatHistory.get(sessionId) || [];
    return history.slice(-limit);
  }

  // ─── Tool Approval ─────────────────────────────────────────────────

  requestApproval(sessionId, toolName, toolInput) {
    const approvalId = crypto.randomUUID();
    const approval = {
      id: approvalId,
      sessionId,
      toolName,
      toolInput,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.emit('approval:requested', approval);
    return approval;
  }

  approveTool(approvalId) {
    this.emit('approval:approved', { approvalId });
    return { approvalId, status: 'approved' };
  }

  denyTool(approvalId) {
    this.emit('approval:denied', { approvalId });
    return { approvalId, status: 'denied' };
  }

  // ─── Status ────────────────────────────────────────────────────────

  getStatus() {
    return {
      agents: this.agents.size,
      sessions: this.sessions.size,
      activeSession: this.activeAgent,
      totalMessages: Array.from(this.chatHistory.values()).reduce((sum, h) => sum + h.length, 0),
    };
  }
}

module.exports = { AIAgentManager };
