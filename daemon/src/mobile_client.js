/**
 * Mobile client from mobile-cc — mobile control patterns.
 */
const http = require('http');
const crypto = require('crypto');

class MobileClient {
    constructor(bridgeUrl) {
        this.bridgeUrl = bridgeUrl;
        this.token = null;
        this.connected = false;
    }

    async connect() {
        const resp = await this.request('POST', '/api/token', {});
        this.token = resp.token;
        this.connected = true;
    }

    async getSessions() {
        return this.request('GET', '/api/sessions');
    }

    async createSession(workspace, agent) {
        return this.request('POST', '/api/session/create', { workspace, agent });
    }

    async approveSession(sessionId) {
        return this.request('POST', '/api/approve', { sessionId });
    }

    async rejectSession(sessionId) {
        return this.request('POST', '/api/reject', { sessionId });
    }

    request(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.bridgeUrl);
            const data = JSON.stringify(body);
            const headers = { 'Content-Type': 'application/json' };
            if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
            const req = http.request(url, { method, headers }, (res) => {
                let result = '';
                res.on('data', (chunk) => { result += chunk; });
                res.on('end', () => { try { resolve(JSON.parse(result)); } catch { resolve(result); } });
            });
            req.on('error', reject);
            if (method !== 'GET') req.write(data);
            req.end();
        });
    }
}

module.exports = { MobileClient };
