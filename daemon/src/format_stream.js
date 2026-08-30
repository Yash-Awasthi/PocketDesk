/**
 * Stream formatting from format-claude-stream — output processing.
 */
class FormatStream {
    constructor() {
        this.buffer = '';
        this.lines = [];
    }

    processChunk(chunk) {
        this.buffer += chunk.toString();
        const parts = this.buffer.split('\n');
        this.buffer = parts.pop();
        for (const part of parts) {
            if (part.trim()) {
                this.lines.push(this.formatLine(part));
            }
        }
    }

    formatLine(line) {
        try {
            const json = JSON.parse(line);
            return { type: 'json', data: json, raw: line };
        } catch {
            if (line.startsWith('error:')) return { type: 'error', message: line.slice(6).trim() };
            if (line.startsWith('[')) return { type: 'array', raw: line };
            return { type: 'text', text: line };
        }
    }

    flush() {
        if (this.buffer.trim()) {
            this.lines.push(this.formatLine(this.buffer));
            this.buffer = '';
        }
        const result = [...this.lines];
        this.lines = [];
        return result;
    }

    getLines() { return this.lines; }
    clear() { this.buffer = ''; this.lines = []; }
}

module.exports = { FormatStream };
