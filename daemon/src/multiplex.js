"""
Terminal multiplexing from multimux — session multiplexing.
"""
const { spawn } = require('child_process');
const EventEmitter = require('events');

class Multiplex extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
        this.activeSession = null;
    }

    createSession(name, options = {}) {
        const id = `mux_${name}_${Date.now()}`;
        const shell = spawn(options.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash'), [], { shell: true, cwd: options.cwd || process.cwd() });
        const session = { id, name, process: shell, output: [], createdAt: Date.now() };
        shell.stdout.on('data', (data) => {
            const line = data.toString();
            session.output.push({ type: 'stdout', text: line, ts: Date.now() });
            if (this.activeSession === id) this.emit('output', { sessionId: id, type: 'stdout', text: line });
        });
        shell.stderr.on('data', (data) => {
            const line = data.toString();
            session.output.push({ type: 'stderr', text: line, ts: Date.now() });
            if (this.activeSession === id) this.emit('output', { sessionId: id, type: 'stderr', text: line });
        });
        shell.on('close', (code) => {
            this.emit('session:closed', { sessionId: id, code });
            this.sessions.delete(id);
        });
        this.sessions.set(id, session);
        this.activeSession = id;
        this.emit('session:created', { sessionId: id, name });
        return id;
    }

    writeTo(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (session?.process?.stdin?.writable) session.process.stdin.write(data);
    }

    switchSession(sessionId) {
        if (this.sessions.has(sessionId)) this.activeSession = sessionId;
    }

    killSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) { session.process.kill('SIGTERM'); this.sessions.delete(sessionId); }
    }

    listSessions() {
        return Array.from(this.sessions.values()).map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, outputLines: s.output.length }));
    }

    getSessionOutput(sessionId, limit = 100) {
        const session = this.sessions.get(sessionId);
        return session ? session.output.slice(-limit) : [];
    }
}

module.exports = { Multiplex };
