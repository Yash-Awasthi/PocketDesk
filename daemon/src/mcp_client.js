/**
 * MCP client from llm-mcp — model context protocol patterns.
 */
const http = require('http');

class MCPClient {
    constructor(serverUrl = 'http://localhost:3000') {
        this.serverUrl = serverUrl;
        this.tools = [];
        this.resources = [];
    }

    async listTools() {
        return this.request('POST', '/mcp', { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    }

    async callTool(name, args) {
        return this.request('POST', '/mcp', { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 2 });
    }

    async listResources() {
        return this.request('POST', '/mcp', { jsonrpc: '2.0', method: 'resources/list', id: 3 });
    }

    async readResource(uri) {
        return this.request('POST', '/mcp', { jsonrpc: '2.0', method: 'resources/read', params: { uri }, id: 4 });
    }

    request(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.serverUrl);
            const data = JSON.stringify(body);
            const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
                let result = '';
                res.on('data', (chunk) => { result += chunk; });
                res.on('end', () => { try { resolve(JSON.parse(result)); } catch { resolve(result); } });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }
}

module.exports = { MCPClient };
