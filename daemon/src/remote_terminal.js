"""
WebSocket remote terminal from claude-remote-terminal.
"""
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class RemoteTerminal extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || 8770;
        this.wss = null;
        this.sessions = new Map();
        this.shell = options.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    }

    start() {
        this.wss = new WebSocketServer({ port: this.port });
        this.wss.on('connection', (ws) => this.handleConnection(ws));
        console.log(`Remote terminal on ws://localhost:${this.port}`);
    }

    handleConnection(ws) {
        const sessionId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const shell = spawn(this.shell, [], { shell: true, env: process.env });

        this.sessions.set(sessionId, { ws, shell, created: Date.now() });

        shell.stdout.on('data', (data) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
            }
        });

        shell.stderr.on('data', (data) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'error', data: data.toString() }));
            }
        });

        shell.on('close', (code) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'exit', code }));
            }
            this.sessions.delete(sessionId);
        });

        ws.on('message', (msg) => {
            try {
                const command = JSON.parse(msg.toString());
                switch (command.type) {
                    case 'input':
                        shell.stdin.write(command.data);
                        break;
                    case 'resize':
                        if (shell.stdout.columns !== undefined) {
                            shell.stdout.columns = command.cols || 80;
                            shell.stdout.rows = command.rows || 24;
                        }
                        break;
                    case 'kill':
                        shell.kill('SIGTERM');
                        break;
                }
            } catch (e) {
                shell.stdin.write(msg.toString());
            }
        });

        ws.on('close', () => {
            shell.kill('SIGTERM');
            this.sessions.delete(sessionId);
        });

        ws.send(JSON.stringify({ type: 'connected', sessionId }));
        this.emit('session:created', sessionId);
    }

    getSessions() {
        return Array.from(this.sessions.entries()).map(([id, s]) => ({
            id,
            created: s.created,
            alive: !s.shell.killed,
        }));
    }

    killSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.shell.kill('SIGTERM');
            this.sessions.delete(sessionId);
        }
    }

    stop() {
        for (const [id, s] of this.sessions) {
            s.shell.kill('SIGTERM');
        }
        this.sessions.clear();
        if (this.wss) this.wss.close();
    }
}

module.exports = { RemoteTerminal };
