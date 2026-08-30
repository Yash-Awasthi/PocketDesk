"""
Persistent terminal from persistent-terminal-api patterns.
"""
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class PersistentTerminal extends EventEmitter {
    constructor(sessionDir = '~/.pocketdesk/terminals') {
        super();
        this.sessionDir = sessionDir;
        this.sessions = new Map();
    }

    create(name, shell) {
        const id = `pt_${name}_${Date.now()}`;
        const proc = spawn(shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash'), [], { shell: true, env: process.env });
        const session = { id, name, process: proc, history: [], savedState: null, createdAt: Date.now() };
        proc.stdout.on('data', (d) => {
            const line = d.toString();
            session.history.push({ type: 'out', text: line, ts: Date.now() });
            this.emit('output', { sessionId: id, text: line });
        });
        proc.stderr.on('data', (d) => {
            session.history.push({ type: 'err', text: d.toString(), ts: Date.now() });
            this.emit('error', { sessionId: id, text: d.toString() });
        });
        proc.on('close', (code) => {
            this.emit('closed', { sessionId: id, code });
            this.saveSession(id);
        });
        this.sessions.set(id, session);
        return id;
    }

    write(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (session?.process?.stdin?.writable) session.process.stdin.write(data);
    }

    saveSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            const state = { id: session.id, name: session.name, history: session.history.slice(-500), savedAt: Date.now() };
            this.sessions.set(sessionId, { ...session, savedState: state });
        }
    }

    listSessions() {
        return Array.from(this.sessions.values()).map(s => ({ id: s.id, name: s.name, historyLen: s.history.length, created: s.createdAt }));
    }

    getHistory(sessionId, limit = 100) {
        return this.sessions.get(sessionId)?.history.slice(-limit) || [];
    }

    kill(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) { session.process.kill('SIGTERM'); this.saveSession(sessionId); }
    }
}

module.exports = { PersistentTerminal };
