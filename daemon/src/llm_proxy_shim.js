/**
 * LLM Proxy Shim — HTTP proxy for routing AI model requests.
 *
 * Inspired by codex-wrapper's litellm_shim.py.
 * Routes local HTTP requests to upstream LLM APIs with header injection,
 * rate limiting, and request/response logging.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface ShimConfig {
  port: number;
  upstream: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs: number;
  maxConcurrentRequests: number;
  logRequests: boolean;
}

export interface ProxyRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  timestamp: Date;
  clientId?: string;
}

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  durationMs: number;
  upstreamHost: string;
}

export interface RequestLog {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: Date;
  clientId?: string;
  error?: string;
}

// ============================================================================
// Hop-by-hop headers (not forwarded)
// ============================================================================

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'accept-encoding',
  'content-encoding', 'host', 'content-length',
]);

// ============================================================================
// LLM Proxy Shim
// ============================================================================

export class LLMProxyShim {
  private config: ShimConfig;
  private server: http.Server | null = null;
  private requestLogs: RequestLog[] = [];
  private activeRequests = 0;
  private totalRequests = 0;
  private totalErrors = 0;

  constructor(config: Partial<ShimConfig> = {}) {
    this.config = {
      port: config.port || 8787,
      upstream: config.upstream || 'https://api.openai.com',
      defaultHeaders: config.defaultHeaders || {},
      timeoutMs: config.timeoutMs || 600_000,
      maxConcurrentRequests: config.maxConcurrentRequests || 50,
      logRequests: config.logRequests ?? true,
    };
  }

  /**
   * Start the proxy server.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 12);

    const startTime = Date.now();

    // Check concurrency limit
    if (this.activeRequests >= this.config.maxConcurrentRequests) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many concurrent requests' }));
      this.totalErrors++;
      return;
    }

    this.activeRequests++;
    this.totalRequests++;

    try {
      const body = await this.readBody(req);

      // Build outgoing headers
      const outHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key && value && !HOP_BY_HOP.has(key.toLowerCase())) {
          outHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }

      // Inject default headers if not present
      for (const [key, value] of Object.entries(this.config.defaultHeaders)) {
        if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === key.toLowerCase())) {
          outHeaders[key] = value;
        }
      }

      // Forward to upstream
      const upstream = new URL(this.config.upstream);
      const isHttps = upstream.protocol === 'https:';
      const port = upstream.port ? parseInt(upstream.port) : (isHttps ? 443 : 80);

      const options = {
        hostname: upstream.hostname,
        port,
        path: req.url || '/',
        method: req.method || 'GET',
        headers: outHeaders,
        timeout: this.config.timeoutMs,
      };

      const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const durationMs = Date.now() - startTime;

          // Filter response headers
          const resHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (key && value && !HOP_BY_HOP.has(key.toLowerCase())) {
              resHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
            }
          }

          // Log request
          if (this.config.logRequests) {
            this.requestLogs.push({
              requestId,
              method: req.method || 'GET',
              path: req.url || '/',
              statusCode: proxyRes.statusCode || 500,
              durationMs,
              timestamp: new Date(),
            });
          }

          res.writeHead(proxyRes.statusCode || 500, resHeaders);
          res.end(responseBody);
          this.activeRequests--;
        });
      });

      proxyReq.on('error', (err) => {
        const durationMs = Date.now() - startTime;
        this.requestLogs.push({
          requestId,
          method: req.method || 'GET',
          path: req.url || '/',
          statusCode: 502,
          durationMs,
          timestamp: new Date(),
          error: err.message,
        });

        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream error', details: err.message }));
        this.activeRequests--;
        this.totalErrors++;
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream timeout' }));
        this.activeRequests--;
        this.totalErrors++;
      });

      proxyReq.write(body);
      proxyReq.end();
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.requestLogs.push({
        requestId,
        method: req.method || 'GET',
        path: req.url || '/',
        statusCode: 500,
        durationMs,
        timestamp: new Date(),
        error: String(err),
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal proxy error' }));
      this.activeRequests--;
      this.totalErrors++;
    }
  }

  /**
   * Read the full request body.
   */
  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /**
   * Get request logs.
   */
  getLogs(limit = 100): RequestLog[] {
    return this.requestLogs.slice(-limit);
  }

  /**
   * Get stats.
   */
  getStats(): { totalRequests: number; totalErrors: number; activeRequests: number; avgDurationMs: number } {
    const recentLogs = this.requestLogs.slice(-100);
    const avgDuration = recentLogs.length > 0
      ? recentLogs.reduce((sum, l) => sum + l.durationMs, 0) / recentLogs.length
      : 0;

    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      activeRequests: this.activeRequests,
      avgDurationMs: Math.round(avgDuration),
    };
  }
}
