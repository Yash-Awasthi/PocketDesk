"""
PTY manager from node-pty patterns — pseudo-terminal management.
"""
const { spawn } = require('child_process');
const EventEmitter = require('events');

class PTYManager extends EventEmitter {
    constructor() {
        super();
        this.terminals = new Map();
    }

    create(cols = 80, rows = 24, shell) {
        const id = `pty_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const proc = spawn(shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash'), [], {
            env: process.env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
        });
        const terminal = { id, process: proc, cols, rows, data: '', createdAt: Date.now() };
        proc.stdout.on('data', (d) => {
            terminal.data += d.toString();
            this.emit('data', { id, data: d.toString() });
        });
        proc.stderr.on('data', (d) => this.emit('data', { id, data: d.toString() }));
        proc.on('close', (code) => { this.emit('close', { id, code }); this.terminals.delete(id); });
        this.terminals.set(id, terminal);
        this.emit('created', { id, cols, rows });
        return id;
    }

    write(id, data) { const t = this.terminals.get(id); if (t?.process?.stdin?.writable) t.process.stdin.write(data); }
    resize(id, cols, rows) { const t = this.terminals.get(id); if (t) { t.cols = cols; t.rows = rows; } }
    kill(id) { const t = this.terminals.get(id); if (t) { t.process.kill('SIGTERM'); this.terminals.delete(id); } }
    list() { return Array.from(this.terminals.values()).map(t => ({ id: t.id, cols: t.cols, rows: t.rows, created: t.createdAt })); }
    getData(id) { return this.terminals.get(id)?.data || ''; }
}

module.exports = { PTYManager };
