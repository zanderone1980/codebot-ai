/**
 * CodeBot AI — Dashboard HTTP Server
 *
 * Lightweight HTTP server using node:http for the web dashboard.
 * Serves static files and API routes. Zero external dependencies.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

/** MIME type mapping for static files */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Route handler signature */
export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

/** Route definition */
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * DashboardServer — lightweight HTTP server for the web dashboard.
 */
export class DashboardServer {
  private server: http.Server | null = null;
  private routes: Route[] = [];
  private port: number;
  private host: string;
  private staticDir: string | null;
  private running: boolean = false;
  private authToken: string;

  constructor(opts?: { port?: number; host?: string; staticDir?: string }) {
    this.port = opts?.port ?? 3120;
    this.host = opts?.host ?? '127.0.0.1';
    this.staticDir = opts?.staticDir ?? null;
    this.authToken = crypto.randomBytes(24).toString('hex');
  }

  /** Get the auth token (for CLI display / embedding in served pages) */
  getAuthToken(): string {
    return this.authToken;
  }

  /** Register an API route */
  route(method: string, pathPattern: string, handler: RouteHandler): void {
    const { pattern, paramNames } = this.compilePath(pathPattern);
    this.routes.push({ method: method.toUpperCase(), pattern, paramNames, handler });
  }

  /** Start the server */
  async start(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          if (!res.writableEnded && !res.destroyed) {
            try { DashboardServer.error(res, 500, 'Internal Server Error'); } catch { /* gone */ }
          }
        });
      });
      this.server.keepAliveTimeout = 65_000;
      this.server.headersTimeout = 70_000;

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Auto-kill stale dashboard process and retry once
          this.killStaleProcess(this.port).then(killed => {
            if (killed) {
              // Retry after killing stale process
              this.server = http.createServer((req2, res2) => {
                this.handleRequest(req2, res2).catch(e => {
                  console.error('Dashboard server error:', e);
                  DashboardServer.error(res2, 500, 'Internal Server Error');
                });
              });
              this.server.on('error', (retryErr: NodeJS.ErrnoException) => {
                reject(new Error(`Port ${this.port} still in use after killing stale process: ${retryErr.message}`));
              });
              this.server.listen(this.port, this.host, () => {
                this.running = true;
                const url = `http://${this.host}:${this.port}`;
                console.log(`Dashboard recovered — killed stale process on port ${this.port}`);
                resolve({ port: this.port, url });
              });
            } else {
              reject(new Error(`Port ${this.port} is already in use (could not kill stale process)`));
            }
          }).catch(() => {
            reject(new Error(`Port ${this.port} is already in use`));
          });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this.running = true;
        const url = `http://${this.host}:${this.port}`;
        resolve({ port: this.port, url });
      });
    });
  }

  /**
   * Kill a stale dashboard process holding the port.
   * Returns true if a process was found and killed.
   */
  private async killStaleProcess(port: number): Promise<boolean> {
    try {
      const output = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 3000 }).trim();
      if (!output) return false;
      const pids = output.split('\n').map(p => parseInt(p, 10)).filter(p => p > 0 && p !== process.pid);
      if (pids.length === 0) return false;
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      // Wait for port to free
      await new Promise(r => setTimeout(r, 1500));
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Check if the server is running */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the port */
  getPort(): number {
    return this.port;
  }

  /** Check Bearer token or query param auth */
  private checkAuth(req: http.IncomingMessage): boolean {
    const rawUrl = req.url || '';
    const query = DashboardServer.parseQuery(rawUrl);
    if (query.token === this.authToken) return true;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7) === this.authToken;
    }
    return false;
  }

  // ── Static helpers for route handlers ──

  /** Send JSON response */
  static json(res: http.ServerResponse, data: unknown, status: number = 200): void {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(body);
  }

  /** Send error response */
  static error(res: http.ServerResponse, status: number, message: string): void {
    if (res.writableEnded || res.destroyed) return;
    DashboardServer.json(res, { error: message }, status);
  }

  /** Parse JSON body from request */
  static async parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 50 * 1024 * 1024; // 50MB limit (base64 images are large)

      req.on('error', reject);

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          const sizeMB = (size / (1024 * 1024)).toFixed(1);
          const limitMB = (MAX_BODY / (1024 * 1024)).toFixed(0);
          console.error(`[parseBody] Body too large: ${sizeMB}MB exceeds ${limitMB}MB limit`);
          reject(new Error(`Request body too large (${sizeMB}MB, limit ${limitMB}MB)`));
          req.removeAllListeners('data');
          req.resume();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(body ? JSON.parse(body) : null);
        } catch (e: any) {
          const sizeKB = Math.round(size / 1024);
          const detail = e?.message || 'unknown parse error';
          console.error(`[parseBody] Failed to parse ${sizeKB}KB body: ${detail}`);
          reject(new Error(`Invalid JSON body (${sizeKB}KB, ${detail})`));
        }
      });
    });
  }

  /** Parse query string parameters */
  static parseQuery(url: string): Record<string, string> {
    const idx = url.indexOf('?');
    if (idx < 0) return {};
    const qs = url.substring(idx + 1);
    const params: Record<string, string> = {};
    for (const pair of qs.split('&')) {
      const [key, val] = pair.split('=');
      if (key) params[decodeURIComponent(key)] = decodeURIComponent(val || '');
    }
    return params;
  }

  // ── SSE (Server-Sent Events) helpers ──

  /** Write SSE headers to start an event stream */
  static sseHeaders(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'X-Accel-Buffering': 'no',
    });
  }

  /** Send a single SSE data event (safe — ignores closed connections) */
  static sseSend(res: http.ServerResponse, data: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  }

  /** Close an SSE stream (safe — checks if writable) */
  static sseClose(res: http.ServerResponse): void {
    if (res.writableEnded || res.destroyed) return;
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
  }

  // ── Private methods ──

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    const rawUrl = req.url || '/';
    const urlPath = rawUrl.split('?')[0];

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Try API routes first
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = urlPath.match(route.pattern);
      if (match) {
        // Require auth for /api/* routes
        if (urlPath.startsWith('/api/') && urlPath !== '/api/health' && !this.checkAuth(req)) {
          DashboardServer.error(res, 401, 'Unauthorized');
          return;
        }
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = match[i + 1] || '';
        }
        await route.handler(req, res, params);
        return;
      }
    }

    // Try static files
    if (this.staticDir && method === 'GET') {
      const served = await this.serveStatic(urlPath, res);
      if (served) return;
    }

    // 404
    DashboardServer.error(res, 404, 'Not Found');
  }

  private async serveStatic(urlPath: string, res: http.ServerResponse): Promise<boolean> {
    if (!this.staticDir) return false;

    // Security: prevent directory traversal
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.staticDir, filePath);

    // Ensure we're still within the static directory
    if (!fullPath.startsWith(this.staticDir)) {
      return false;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return false;

      const ext = path.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';

      let content: Buffer | string = await fs.promises.readFile(fullPath);

      // Inject auth token into index.html so the frontend JS can use it
      if (path.basename(fullPath) === 'index.html') {
        const html = content.toString('utf-8');
        const tokenScript = `<script>window.__CODEBOT_TOKEN="${this.authToken}";</script>`;
        content = Buffer.from(html.replace('</head>', `${tokenScript}\n</head>`));
      }
      const headers: Record<string, string | number> = {
        'Content-Type': mime,
        'Content-Length': Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      };
      // Don't allow cross-origin access to index.html (contains auth token)
      if (path.basename(fullPath) !== 'index.html') {
        headers['Access-Control-Allow-Origin'] = '*';
      }
      res.writeHead(200, headers);
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  /** Compile a path pattern like /api/sessions/:id into a RegExp */
  private compilePath(pathPattern: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexStr = pathPattern.replace(/:([a-zA-Z_]+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    return { pattern: new RegExp(`^${regexStr}$`), paramNames };
  }
}
