"""
OpenCode bridge from opencode patterns — coding assistant bridge.
"""
const { spawn } = require('child_process');
const EventEmitter = require('events');

class OpenCodeBridge extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
    }

    startSession(projectPath, agent = 'claude') {
        const id = `oc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const proc = spawn(agent, ['--project', projectPath], { shell: true, env: process.env, cwd: projectPath });
        const session = { id, process: proc, projectPath, agent, output: [], createdAt: Date.now() };
        proc.stdout.on('data', (d) => {
            const line = d.toString();
            session.output.push(line);
            this.emit('output', { sessionId: id, text: line });
        });
        proc.stderr.on('data', (d) => {
            session.output.push(d.toString());
            this.emit('error', { sessionId: id, text: d.toString() });
        });
        proc.on('close', (code) => {
            this.emit('closed', { sessionId: id, code });
            this.sessions.delete(id);
        });
        this.sessions.set(id, session);
        this.emit('started', { sessionId: id, projectPath, agent });
        return id;
    }

    sendInput(sessionId, input) {
        const session = this.sessions.get(sessionId);
        if (session?.process?.stdin?.writable) session.process.stdin.write(input + '\n');
    }

    killSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) { session.process.kill('SIGTERM'); this.sessions.delete(sessionId); }
    }

    listSessions() {
        return Array.from(this.sessions.values()).map(s => ({ id: s.id, project: s.projectPath, agent: s.agent, created: s.createdAt, outputLines: s.output.length }));
    }
}

module.exports = { OpenCodeBridge };
