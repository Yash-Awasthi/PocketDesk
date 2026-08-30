/**
 * Terminal session from interactive-terminal — session management.
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');

class TerminalSession extends EventEmitter {
    constructor(options = {}) {
        super();
        this.id = `term_${Date.now()}`;
        this.shell = options.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
        this.cwd = options.cwd || process.cwd();
        this.process = null;
        this.output = [];
        this.createdAt = Date.now();
    }

    start() {
        this.process = spawn(this.shell, [], { cwd: this.cwd, env: process.env, shell: true });
        this.process.stdout.on('data', (data) => {
            const line = data.toString();
            this.output.push({ type: 'stdout', text: line, timestamp: Date.now() });
            this.emit('output', { sessionId: this.id, type: 'stdout', text: line });
        });
        this.process.stderr.on('data', (data) => {
            const line = data.toString();
            this.output.push({ type: 'stderr', text: line, timestamp: Date.now() });
            this.emit('output', { sessionId: this.id, type: 'stderr', text: line });
        });
        this.process.on('close', (code) => {
            this.emit('closed', { sessionId: this.id, code });
        });
        this.emit('started', { sessionId: this.id });
    }

    write(data) { if (this.process?.stdin?.writable) this.process.stdin.write(data); }
    kill() { if (this.process) this.process.kill('SIGTERM'); }
    getOutput(limit = 100) { return this.output.slice(-limit); }
    isAlive() { return this.process && !this.process.killed; }
}

module.exports = { TerminalSession };
