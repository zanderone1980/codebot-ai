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

  constructor(opts?: { port?: number; host?: string; staticDir?: string }) {
    this.port = opts?.port ?? 3120;
    this.host = opts?.host ?? '127.0.0.1';
    this.staticDir = opts?.staticDir ?? null;
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
          console.error('Dashboard server error:', err);
          DashboardServer.error(res, 500, 'Internal Server Error');
        });
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use`));
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

  // ── Static helpers for route handlers ──

  /** Send JSON response */
  static json(res: http.ServerResponse, data: unknown, status: number = 200): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(body);
  }

  /** Send error response */
  static error(res: http.ServerResponse, status: number, message: string): void {
    DashboardServer.json(res, { error: message }, status);
  }

  /** Parse JSON body from request */
  static async parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 1024 * 1024; // 1MB limit

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(body ? JSON.parse(body) : null);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', reject);
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Accel-Buffering': 'no',
    });
  }

  /** Send a single SSE data event */
  static sseSend(res: http.ServerResponse, data: unknown): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** Close an SSE stream */
  static sseClose(res: http.ServerResponse): void {
    res.write('data: [DONE]\n\n');
    res.end();
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Try API routes first
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = urlPath.match(route.pattern);
      if (match) {
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

      const content = fs.readFileSync(fullPath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': content.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
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
