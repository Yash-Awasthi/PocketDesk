/**
 * Tests for Agent Orchestrator.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AgentOrchestrator, AgentType, AgentStatus, AgentSession, WorktreeManager } from '../agent_orchestrator.js';

describe('AgentOrchestrator', () => {
  let orchestrator;

  beforeEach(() => {
    orchestrator = new AgentOrchestrator({ maxConcurrent: 3 });
  });

  it('creates a session', async () => {
    const session = await orchestrator.createSession({ agentType: AgentType.CLAUDE });
    assert.strictEqual(session.agentType, AgentType.CLAUDE);
    assert.strictEqual(session.status, AgentStatus.IDLE);
  });

  it('starts a session', async () => {
    const session = await orchestrator.createSession({});
    await orchestrator.startSession(session.id);
    assert.strictEqual(session.status, AgentStatus.RUNNING);
  });

  it('enforces max concurrent', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await orchestrator.createSession({});
      await orchestrator.startSession(s.id);
    }
    const extra = await orchestrator.createSession({});
    await assert.rejects(() => orchestrator.startSession(extra.id), /Max concurrent/);
  });

  it('pauses and resumes', async () => {
    const session = await orchestrator.createSession({});
    await orchestrator.startSession(session.id);
    await orchestrator.pauseSession(session.id);
    assert.strictEqual(session.status, AgentStatus.PAUSED);
    await orchestrator.resumeSession(session.id);
    assert.strictEqual(session.status, AgentStatus.RUNNING);
  });

  it('completes a session', async () => {
    const session = await orchestrator.createSession({});
    await orchestrator.startSession(session.id);
    await orchestrator.completeSession(session.id);
    assert.strictEqual(session.status, AgentStatus.COMPLETED);
  });

  it('handles errors', async () => {
    const session = await orchestrator.createSession({});
    await orchestrator.startSession(session.id);
    await orchestrator.errorSession(session.id, 'API timeout');
    assert.strictEqual(session.status, AgentStatus.ERROR);
    assert.strictEqual(session.error, 'API timeout');
  });

  it('lists sessions with filter', async () => {
    await orchestrator.createSession({ agentType: AgentType.CLAUDE });
    await orchestrator.createSession({ agentType: AgentType.CODEX });
    const claudeOnly = orchestrator.listSessions({ agentType: AgentType.CLAUDE });
    assert.strictEqual(claudeOnly.length, 1);
  });

  it('gets stats', async () => {
    const s1 = await orchestrator.createSession({});
    await orchestrator.startSession(s1.id);
    const s2 = await orchestrator.createSession({});
    const stats = orchestrator.getStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.active, 1);
  });

  it('broadcasts to active sessions', async () => {
    const s1 = await orchestrator.createSession({});
    await orchestrator.startSession(s1.id);
    await orchestrator.broadcast('hello');
    assert.strictEqual(s1.messages.length, 1);
    assert.strictEqual(s1.messages[0].content, 'hello');
  });
});

describe('AgentSession', () => {
  it('records tool use', () => {
    const session = new AgentSession({});
    session.recordToolUse('read_file', { path: '/foo' }, 'content');
    assert.strictEqual(session.toolsUsed.length, 1);
    assert.strictEqual(session.toolsUsed[0].toolName, 'read_file');
  });

  it('adds messages', () => {
    const session = new AgentSession({});
    session.addMessage('user', 'hello');
    session.addMessage('assistant', 'hi');
    assert.strictEqual(session.messages.length, 2);
  });

  it('serializes to JSON', () => {
    const session = new AgentSession({ agentType: AgentType.CODEX });
    const json = session.toJSON();
    assert.strictEqual(json.agentType, AgentType.CODEX);
    assert.strictEqual(json.messageCount, 0);
  });
});

describe('WorktreeManager', () => {
  it('creates and lists worktrees', async () => {
    const wm = new WorktreeManager('/tmp/test-wt');
    const path = await wm.create('feature1');
    assert.ok(path.includes('feature1'));
    const list = wm.list();
    assert.strictEqual(list.length, 1);
  });

  it('removes worktrees', async () => {
    const wm = new WorktreeManager('/tmp/test-wt');
    await wm.create('feature1');
    await wm.remove('feature1');
    assert.strictEqual(wm.list().length, 0);
  });
});
