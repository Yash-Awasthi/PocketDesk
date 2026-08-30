/**
 * HTTP Connection Pool — connection pooling and reuse.
 * Extracted from advocate — connection pool patterns.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class HTTPConnectionPool {
  constructor(options = {}) {
    this.maxConnections = options.maxConnections || 10;
    this.keepAlive = options.keepAlive !== false;
    this.keepAliveTimeout = options.keepAliveTimeout || 30000;
    this.pools = new Map();
    this.activeRequests = 0;
    this.queue = [];
  }

  getPool(origin) {
    if (!this.pools.has(origin)) {
      this.pools.set(origin, {
        origin,
        sockets: [],
        requests: 0,
        lastUsed: Date.now(),
      });
    }
    return this.pools.get(origin);
  }

  async request(url, options = {}) {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const pool = this.getPool(origin);

    return new Promise((resolve, reject) => {
      const makeRequest = () => {
        this.activeRequests++;
        pool.requests++;
        pool.lastUsed = Date.now();

        const reqOptions = {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: options.method || 'GET',
          headers: {
            'User-Agent': 'PocketDesk/1.0',
            'Connection': this.keepAlive ? 'keep-alive' : 'close',
            ...options.headers,
          },
          timeout: options.timeout || 30000,
        };

        const protocol = parsed.protocol === 'https:' ? https : http;
        const req = protocol.request(reqOptions, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            this.activeRequests--;
            this.processQueue();
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: data,
            });
          });
        });

        req.on('error', (err) => {
          this.activeRequests--;
          this.processQueue();
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          this.activeRequests--;
          this.processQueue();
          reject(new Error('Request timeout'));
        });

        if (options.body) {
          req.write(options.body);
        }
        req.end();
      };

      if (this.activeRequests >= this.maxConnections) {
        this.queue.push(makeRequest);
      } else {
        makeRequest();
      }
    });
  }

  processQueue() {
    while (this.queue.length > 0 && this.activeRequests < this.maxConnections) {
      const next = this.queue.shift();
      next();
    }
  }

  getStats() {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.queue.length,
      pools: Array.from(this.pools.values()).map(p => ({
        origin: p.origin,
        requests: p.requests,
        lastUsed: p.lastUsed,
      })),
    };
  }

  close() {
    this.queue = [];
    this.pools.clear();
  }
}

module.exports = { HTTPConnectionPool };
