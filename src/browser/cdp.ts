/**
 * Minimal Chrome DevTools Protocol client.
 * Zero dependencies — uses Node's built-in net/http/crypto modules.
 */
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';

interface CDPResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string; code?: number };
  method?: string;
  params?: Record<string, unknown>;
}

export class CDPClient {
  private socket: net.Socket | null = null;
  private messageId = 0;
  private pending = new Map<number, { resolve: (v: CDPResponse) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private connected = false;

  /** Connect to Chrome's debugging WebSocket */
  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString('base64');

      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (_res, socket) => {
        this.socket = socket;
        this.connected = true;

        socket.on('data', (data: Buffer) => this.onData(data));
        socket.on('close', () => {
          this.connected = false;
          this.socket = null;
        });
        socket.on('error', (err) => {
          this.connected = false;
          for (const [, p] of this.pending) {
            p.reject(err);
          }
          this.pending.clear();
        });

        resolve();
      });

      req.on('error', reject);
      req.end();
    });
  }

  /** Send a CDP command and wait for response */
  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to Chrome');
    }

    const id = ++this.messageId;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          if (resp.error) {
            reject(new Error(`CDP error: ${resp.error.message}`));
          } else {
            resolve(resp.result || {});
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.sendFrame(msg);
    });
  }

  /** Close the connection */
  close() {
    if (this.socket) {
      try {
        // Send WebSocket close frame
        const closeFrame = Buffer.alloc(6);
        closeFrame[0] = 0x88; // FIN + Close
        closeFrame[1] = 0x80; // Masked, 0 length
        this.socket.write(closeFrame);
      } catch {
        // ignore
      }
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Send a WebSocket text frame (masked, as required by client) */
  private sendFrame(data: string) {
    if (!this.socket) return;

    const payload = Buffer.from(data, 'utf-8');
    const mask = crypto.randomBytes(4);

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81; // FIN + Text
      header[1] = 0x80 | payload.length; // Masked + length
      mask.copy(header, 2);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      // Write 64-bit length (we only use lower 32 bits)
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
      mask.copy(header, 10);
    }

    // Mask the payload
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(Buffer.concat([header, masked]));
  }

  /** Handle incoming data — parse WebSocket frames */
  private onData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const isFin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return; // Need more data
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = this.buffer.readUInt32BE(6); // Only lower 32 bits
        offset = 10;
      }

      if (isMasked) offset += 4; // Skip mask (server shouldn't mask)

      if (this.buffer.length < offset + payloadLength) return; // Need more data

      const payload = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (opcode === 0x01 && isFin) {
        // Text frame
        const text = payload.toString('utf-8');
        try {
          const msg: CDPResponse = JSON.parse(text);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            handler.resolve(msg);
          }
          // Events (no id) are ignored for now
        } catch {
          // Malformed JSON, skip
        }
      } else if (opcode === 0x08) {
        // Close frame
        this.close();
      } else if (opcode === 0x09) {
        // Ping — respond with pong
        this.sendPong(payload);
      }
    }
  }

  private sendPong(data: Buffer) {
    if (!this.socket) return;
    const mask = crypto.randomBytes(4);
    const header = Buffer.alloc(6);
    header[0] = 0x8a; // FIN + Pong
    header[1] = 0x80 | data.length;
    mask.copy(header, 2);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      masked[i] = data[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, masked]));
  }
}

/** Get the WebSocket debugger URL from Chrome's HTTP endpoint */
export async function getDebuggerUrl(port = 9222): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(info.webSocketDebuggerUrl);
        } catch {
          reject(new Error('Failed to parse Chrome debugger info'));
        }
      });
    });
    req.on('error', () => reject(new Error(`Chrome not running on port ${port}. Launch with: chrome --remote-debugging-port=${port}`)));
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('Chrome debugger timeout'));
    });
  });
}

/** Get list of open tabs */
export async function getTargets(port = 9222): Promise<Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }>> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Failed to parse targets'));
        }
      });
    });
    req.on('error', () => reject(new Error('Chrome not accessible')));
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}
