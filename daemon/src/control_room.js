"""
Control room from control-room — multi-session management and monitoring.
"""
const EventEmitter = require('events');
const { SessionMonitor } = require('./session_monitor');

class ControlRoom extends EventEmitter {
    constructor() {
        super();
        this.monitor = new SessionMonitor();
        this.agents = new Map();
        this.commands = new Map();
        this.eventLog = [];
        this.registerDefaults();
    }

    registerDefaults() {
        this.registerCommand('list', () => this.monitor.getActiveSessions().map(s => ({ id: s.id, pid: s.pid, status: s.status })));
        this.registerCommand('status', () => this.monitor.getSessionStats());
        this.registerCommand('kill', (args) => {
            const pid = parseInt(args[0]);
            if (pid) this.monitor.updateSession(pid, { status: 'terminated' });
            return { killed: pid };
        });
        this.registerCommand('history', () => this.monitor.getHistory());
        this.registerCommand('log', () => this.eventLog.slice(-50));
    }

    registerCommand(name, handler) { this.commands.set(name, handler); }

    executeCommand(name, args = []) {
        const handler = this.commands.get(name);
        if (!handler) return { error: `Unknown command: ${name}` };
        const result = handler(args);
        this.eventLog.push({ command: name, args, timestamp: Date.now(), result });
        this.emit('command:executed', { name, args, result });
        return result;
    }

    start() { this.monitor.start(); this.emit('started'); }
    stop() { this.monitor.stop(); this.emit('stopped'); }
}

module.exports = { ControlRoom };
