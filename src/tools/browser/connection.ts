/**
 * Browser connection management — Chrome launch, CDP connection, session state.
 * Extracted from browser.ts for maintainability.
 */

import { CDPClient, getDebuggerUrl, getTargets } from '../../browser/cdp';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PolicyEnforcer } from '../../policy';
import { codebotPath } from '../../paths';

// Shared browser instance across tool calls
let client: CDPClient | null = null;
const debugPort = 9222;
let connectingPromise: Promise<CDPClient> | null = null;

/** Last screenshot base64 data — picked up by agent for vision-capable LLMs */
export let lastScreenshotData: string | null = null;

/** Set the last screenshot data (called from BrowserTool) */
export function setLastScreenshotData(data: string | null): void {
  lastScreenshotData = data;
}

/** Get the current CDP client */
export function getClient(): CDPClient | null { return client; }

/** Set the current CDP client */
export function setClient(c: CDPClient | null): void { client = c; }

/** Get the debug port */
export function getDebugPort(): number { return debugPort; }

/**
 * BrowserSession — encapsulates browser connection state.
 */
export class BrowserSession {
  private static instance: BrowserSession | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private fallbackMode = false;

  static getInstance(): BrowserSession {
    if (!BrowserSession.instance) {
      BrowserSession.instance = new BrowserSession();
    }
    return BrowserSession.instance;
  }

  isFallbackMode(): boolean { return this.fallbackMode; }
  enableFallback(): void { this.fallbackMode = true; }
  resetFallback(): void { this.fallbackMode = false; this.reconnectAttempts = 0; }
  getScreenshot(): string | null { return lastScreenshotData; }
  clearScreenshot(): void { lastScreenshotData = null; }

  shouldReconnect(): boolean {
    this.reconnectAttempts++;
    return this.reconnectAttempts <= this.maxReconnectAttempts;
  }

  getStatus(): { connected: boolean; fallback: boolean; reconnectAttempts: number } {
    return {
      connected: client?.isConnected() ?? false,
      fallback: this.fallbackMode,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

/**
 * Kill any Chrome using our debug port or data dir.
 */
export function killExistingChrome(): void {
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }

  try {
    const enforcer = new PolicyEnforcer();
    const toolCheck = enforcer.isToolAllowed('browser');
    if (!toolCheck.allowed) return;
  } catch {}

  const { execSync } = require('child_process');
  const myPid = process.pid;
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${debugPort}') do taskkill /F /PID %a`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -ti:${debugPort} | grep -v "^${myPid}$" | xargs kill -15 2>/dev/null || true`, { stdio: 'ignore' });
      execSync(`pkill -15 -f "chrome.*--user-data-dir=${codebotPath('chrome-profile')}" 2>/dev/null || true`, { stdio: 'ignore' });
      execSync('sleep 0.5', { stdio: 'ignore' });
      execSync(`lsof -ti:${debugPort} | grep -v "^${myPid}$" | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {}
}

export async function ensureConnected(): Promise<CDPClient> {
  if (client?.isConnected()) return client;

  const session = BrowserSession.getInstance();
  if (session.isFallbackMode()) {
    throw new Error('Browser unavailable — running in fetch-only fallback mode. Use web_search or http_client tools instead.');
  }

  if (connectingPromise) return connectingPromise;

  connectingPromise = doConnect();
  try {
    const cdp = await connectingPromise;
    cdp.onDisconnect(() => { client = null; });
    return cdp;
  } catch (err) {
    if (session.shouldReconnect()) {
      const attempt = session.getStatus().reconnectAttempts;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(r => setTimeout(r, delay));
      connectingPromise = null;
      return ensureConnected();
    }
    session.enableFallback();
    throw err;
  } finally {
    connectingPromise = null;
  }
}

async function doConnect(): Promise<CDPClient> {
  try {
    const wsUrl = await getDebuggerUrl(debugPort);
    client = new CDPClient();
    await client.connect(wsUrl);

    const targets = await getTargets(debugPort);
    const page = targets.find((t: any) => t.url !== 'about:blank' && !t.url.startsWith('devtools://'))
      || targets[0];

    if (page?.webSocketDebuggerUrl) {
      client.close();
      client = new CDPClient();
      await client.connect(page.webSocketDebuggerUrl);
    }

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    return client;
  } catch {
    killExistingChrome();
    await new Promise(r => setTimeout(r, 500));
  }

  const envChrome = process.env.CHROME_PATH;
  const chromePaths = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'linux'
    ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium']
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'google-chrome', 'chromium'];

  let launched = false;
  fs.mkdirSync(codebotPath('chrome-profile'), { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${codebotPath('chrome-profile')}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ];

  if (process.platform === 'darwin') {
    const macPaths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    for (const chromePath of macPaths) {
      try {
        if (fs.existsSync(chromePath)) {
          const child = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
          child.unref();
          launched = true;
          break;
        }
      } catch { continue; }
    }
  }

  if (!launched && envChrome) {
    try {
      if (fs.existsSync(envChrome)) {
        const child = spawn(envChrome, chromeArgs, { stdio: 'ignore', detached: true });
        child.unref();
        launched = true;
      }
    } catch {}
  }

  if (!launched) {
    for (const chromePath of chromePaths) {
      try {
        const child = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
        child.unref();
        launched = true;
        break;
      } catch { continue; }
    }
  }

  if (!launched) {
    throw new Error(
      'Could not launch Chrome. Tried common paths but none found.\n\n' +
      'Options:\n' +
      '  1. Install Google Chrome\n' +
      `  2. Set CHROME_PATH env var: export CHROME_PATH=/path/to/chrome\n` +
      `  3. Start Chrome manually: chrome --remote-debugging-port=${debugPort}\n` +
      '\nOn macOS:\n' +
      `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${debugPort}`
    );
  }

  const backoffDelays = [500, 1000, 2000, 4000, 4000, 4000];
  for (let i = 0; i < backoffDelays.length; i++) {
    try {
      await new Promise(r => setTimeout(r, backoffDelays[i]));
      const wsUrl = await getDebuggerUrl(debugPort);
      client = new CDPClient();
      await client.connect(wsUrl);

      const targets = await getTargets(debugPort);
      const page = targets[0];
      if (page?.webSocketDebuggerUrl) {
        client.close();
        client = new CDPClient();
        await client.connect(page.webSocketDebuggerUrl);
      }

      await client.send('Page.enable');
      await client.send('Runtime.enable');
      return client;
    } catch { continue; }
  }

  throw new Error('Chrome launched but could not connect via CDP');
}
