import { Tool } from '../types';
import { CDPClient, getDebuggerUrl, getTargets } from '../browser/cdp';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Shared browser instance across tool calls
let client: CDPClient | null = null;
let debugPort = 9222;
let connectingPromise: Promise<CDPClient> | null = null;
const CHROME_DATA_DIR = path.join(os.homedir(), '.codebot', 'chrome-profile');

/** Kill any Chrome using our debug port or data dir (but NEVER kill ourselves) */
function killExistingChrome(): void {
  // Close our own CDP connection first so we don't hold the port
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }

  const { execSync } = require('child_process');
  const myPid = process.pid;
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${debugPort}') do taskkill /F /PID %a`, { stdio: 'ignore' });
    } else {
      // Kill Chrome/Chromium processes on our debug port — exclude our own PID
      execSync(`lsof -ti:${debugPort} | grep -v "^${myPid}$" | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      // Also kill any Chrome using our data dir
      execSync(`pkill -9 -f "chrome.*--user-data-dir=${CHROME_DATA_DIR}" 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {
    // ignore — nothing to kill
  }
}

async function ensureConnected(): Promise<CDPClient> {
  // Fast path: already connected
  if (client?.isConnected()) return client;

  // Mutex: if another call is already connecting, reuse that promise
  if (connectingPromise) return connectingPromise;

  connectingPromise = doConnect();
  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function doConnect(): Promise<CDPClient> {
  // Try connecting to existing Chrome with debug port
  try {
    const wsUrl = await getDebuggerUrl(debugPort);
    client = new CDPClient();
    await client.connect(wsUrl);

    // Get or create a page target
    const targets = await getTargets(debugPort);
    const page = targets.find(t => t.url !== 'about:blank' && !t.url.startsWith('devtools://'))
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
    // Can't connect — kill stale processes and launch fresh
    killExistingChrome();
    await new Promise(r => setTimeout(r, 500));
  }

  // Launch Chrome with debugging
  const chromePaths = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'linux'
    ? [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        'google-chrome',
        'chromium',
      ];

  let launched = false;

  // Create isolated Chrome profile dir so it doesn't conflict with user's running Chrome
  fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ];

  // On macOS, launch directly (not via 'open -a' which reuses existing instance)
  if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const chromePath of macPaths) {
      try {
        if (fs.existsSync(chromePath)) {
          const child = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
          child.unref();
          launched = true;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!launched) {
    for (const chromePath of chromePaths) {
      try {
        const child = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
        child.unref();
        launched = true;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!launched) {
    throw new Error(
      'Could not launch Chrome. Start Chrome manually with:\n' +
      `  chrome --remote-debugging-port=${debugPort}\n` +
      'Or on macOS:\n' +
      `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${debugPort}`
    );
  }

  // Wait for Chrome to start — exponential backoff: 500ms, 1s, 2s, 4s
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
    } catch {
      continue;
    }
  }

  throw new Error('Chrome launched but could not connect via CDP');
}

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Control a web browser. Navigate to URLs, read page content, click elements, type text, scroll, press keys, find elements by text, hover, manage tabs, run JavaScript, and take screenshots. Use for web browsing, social media, email, research, testing, and automation.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: [
          'navigate', 'content', 'screenshot', 'click', 'type', 'evaluate',
          'tabs', 'close', 'scroll', 'wait', 'press_key', 'hover',
          'find_by_text', 'switch_tab', 'new_tab',
        ],
      },
      url: { type: 'string', description: 'URL to navigate to (for navigate/new_tab)' },
      selector: { type: 'string', description: 'CSS selector for element (for click/type/scroll/hover)' },
      text: { type: 'string', description: 'Text to type (type) or text to search for (find_by_text)' },
      expression: { type: 'string', description: 'JavaScript to evaluate (for evaluate action)' },
      direction: { type: 'string', description: 'Scroll direction: up, down, left, right (for scroll)', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Scroll pixels (default 400) or wait ms (default 1000)' },
      key: { type: 'string', description: 'Key to press: Enter, Escape, Tab, ArrowDown, etc. (for press_key)' },
      tag: { type: 'string', description: 'HTML tag to filter: button, a, div, etc. (for find_by_text)' },
      index: { type: 'number', description: 'Tab index 1-based (for switch_tab)' },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'navigate':
          return await this.navigate(args.url as string);
        case 'content':
          return await this.getContent();
        case 'screenshot':
          return await this.screenshot();
        case 'click':
          return await this.click(args.selector as string);
        case 'type':
          return await this.typeText(args.selector as string, args.text as string);
        case 'evaluate':
          return await this.evaluate(args.expression as string);
        case 'tabs':
          return await this.listTabs();
        case 'close':
          return this.closeBrowser();
        case 'scroll':
          return await this.scroll(args.selector as string | undefined, args.direction as string || 'down', args.amount as number || 400);
        case 'wait':
          return await this.wait(args.amount as number || 1000);
        case 'press_key':
          return await this.pressKey(args.key as string, args.selector as string | undefined);
        case 'hover':
          return await this.hover(args.selector as string);
        case 'find_by_text':
          return await this.findByText(args.text as string, args.tag as string | undefined);
        case 'switch_tab':
          return await this.switchTab(args.index as number | undefined, args.url as string | undefined);
        case 'new_tab':
          return await this.newTab(args.url as string | undefined);
        default:
          return `Unknown action: ${action}. Available: navigate, content, screenshot, click, type, evaluate, tabs, close, scroll, wait, press_key, hover, find_by_text, switch_tab, new_tab`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Browser error: ${msg}`;
    }
  }

  private async navigate(url: string): Promise<string> {
    if (!url) return 'Error: url is required';
    const cdp = await ensureConnected();

    // Auto-add protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // Set up load event listener BEFORE navigating
    const loadPromise = cdp.waitForEvent('Page.loadEventFired', 15000);

    await cdp.send('Page.navigate', { url });

    // Wait for actual page load event (up to 15s)
    await loadPromise;

    // Extra delay for SPA hydration (React, Next.js, etc.)
    await new Promise(r => setTimeout(r, 1500));

    // Get final URL (after redirects) and page title
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, url: window.location.href })',
      returnByValue: true,
    });
    const val = (result.result as Record<string, unknown>)?.value as string;
    let title = 'untitled';
    let finalUrl = url;
    try {
      const parsed = JSON.parse(val);
      title = parsed.title || 'untitled';
      finalUrl = parsed.url || url;
    } catch {
      // fallback
    }

    return `Navigated to: ${finalUrl}\nTitle: ${title}`;
  }

  private async getContent(): Promise<string> {
    const cdp = await ensureConnected();

    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          // Remove scripts and styles
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());

          // Get text content, preserving structure
          function getText(node, depth) {
            if (depth > 10) return '';
            let text = '';
            for (const child of node.childNodes) {
              if (child.nodeType === 3) {
                text += child.textContent.trim() + ' ';
              } else if (child.nodeType === 1) {
                const tag = child.tagName.toLowerCase();
                if (['div', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'section', 'article'].includes(tag)) {
                  text += '\\n';
                }
                // Include link hrefs
                if (tag === 'a' && child.href) {
                  text += getText(child, depth + 1) + ' [' + child.href + '] ';
                } else if (tag === 'img' && child.alt) {
                  text += '[image: ' + child.alt + '] ';
                } else {
                  text += getText(child, depth + 1);
                }
              }
            }
            return text;
          }

          let content = 'URL: ' + window.location.href + '\\n';
          content += 'Title: ' + document.title + '\\n\\n';
          content += getText(clone, 0);
          return content.replace(/\\n\\s*\\n\\s*\\n/g, '\\n\\n').substring(0, 30000);
        })()
      `,
      returnByValue: true,
    });

    return (result.result as Record<string, unknown>)?.value as string || 'No content';
  }

  private async screenshot(): Promise<string> {
    const cdp = await ensureConnected();
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const data = result.data as string;

    if (!data) return 'Failed to capture screenshot';

    // Save to temp file
    const filePath = path.join(os.tmpdir(), `codebot-screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

    return `Screenshot saved: ${filePath} (${Math.round(data.length * 0.75 / 1024)}KB)`;
  }

  private async click(selector: string): Promise<string> {
    if (!selector) return 'Error: selector is required';
    const cdp = await ensureConnected();

    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
          el.scrollIntoView({ block: 'center' });
          el.click();
          return 'Clicked: ' + (el.tagName || '') + ' ' + (el.textContent || '').substring(0, 50).trim();
        })()
      `,
      returnByValue: true,
    });

    return (result.result as Record<string, unknown>)?.value as string || 'Click executed';
  }

  private async typeText(selector: string, text: string): Promise<string> {
    if (!selector) return 'Error: selector is required';
    if (!text) return 'Error: text is required';
    const cdp = await ensureConnected();

    // Focus the element and clear it
    await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            el.focus();
            if ('value' in el) el.value = '';
          }
        })()
      `,
    });

    // Type character by character using Input.dispatchKeyEvent
    for (const char of text) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        key: char,
        code: `Key${char.toUpperCase()}`,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
        code: `Key${char.toUpperCase()}`,
      });
    }

    // React-compatible value setter — works with Twitter/X, Gmail, and any React/Vue app
    await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return;

          // Try native setter from prototype (bypasses React's synthetic event system)
          const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          const setter = textareaSetter || inputSetter;

          if (setter && 'value' in el) {
            setter.call(el, ${JSON.stringify(text)});
          } else if ('value' in el) {
            el.value = ${JSON.stringify(text)};
          } else if (el.isContentEditable || el.getAttribute('contenteditable') !== null) {
            // ContentEditable elements (used by Twitter/X compose box)
            el.textContent = ${JSON.stringify(text)};
          }

          // Fire events that React/Vue/Angular listen to
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `,
    });

    return `Typed "${text.length > 50 ? text.substring(0, 50) + '...' : text}" into ${selector}`;
  }

  private async evaluate(expression: string): Promise<string> {
    if (!expression) return 'Error: expression is required';
    const cdp = await ensureConnected();

    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    const val = result.result as Record<string, unknown>;
    if (val?.type === 'undefined') return 'undefined';
    if (val?.value !== undefined) {
      return typeof val.value === 'string' ? val.value : JSON.stringify(val.value, null, 2);
    }

    const exception = result.exceptionDetails as Record<string, unknown> | undefined;
    if (exception) {
      const ex = exception.exception as Record<string, unknown>;
      return `Error: ${ex?.description || ex?.value || 'Unknown error'}`;
    }

    return JSON.stringify(val, null, 2);
  }

  private async listTabs(): Promise<string> {
    try {
      const targets = await getTargets(debugPort);
      if (targets.length === 0) return 'No tabs open.';

      return targets
        .filter(t => t.url && !t.url.startsWith('devtools://'))
        .map((t, i) => `${i + 1}. ${t.title || '(no title)'}\n   ${t.url}`)
        .join('\n');
    } catch {
      return 'Browser not connected. Use navigate first.';
    }
  }

  private closeBrowser(): string {
    if (client) {
      client.close();
      client = null;
    }
    return 'Browser connection closed.';
  }

  // ─── New Actions ─────────────────────────────────────────────

  private async scroll(selector: string | undefined, direction: string, amount: number): Promise<string> {
    const cdp = await ensureConnected();

    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'window'};
          if (!target && ${JSON.stringify(selector)}) return 'Element not found: ' + ${JSON.stringify(selector)};
          const x = '${direction}' === 'right' ? ${amount} : '${direction}' === 'left' ? -${amount} : 0;
          const y = '${direction}' === 'down' ? ${amount} : '${direction}' === 'up' ? -${amount} : 0;
          (target.scrollBy || window.scrollBy).call(target, { left: x, top: y, behavior: 'smooth' });
          return 'Scrolled ${direction} by ${amount}px' + (${JSON.stringify(selector)} ? ' on ' + ${JSON.stringify(selector)} : '');
        })()
      `,
      returnByValue: true,
    });

    return (result.result as Record<string, unknown>)?.value as string || `Scrolled ${direction}`;
  }

  private async wait(ms: number): Promise<string> {
    const clamped = Math.min(Math.max(ms, 100), 10000);
    await new Promise(r => setTimeout(r, clamped));
    return `Waited ${clamped}ms`;
  }

  private async pressKey(key: string, selector?: string): Promise<string> {
    if (!key) return 'Error: key is required (e.g., Enter, Escape, Tab, ArrowDown)';
    const cdp = await ensureConnected();

    // Focus element first if selector provided
    if (selector) {
      await cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) el.focus();
          })()
        `,
      });
    }

    // Map key names to their proper key codes
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'Space': { key: ' ', code: 'Space', keyCode: 32 },
    };

    const mapped = keyMap[key] || { key, code: `Key${key}`, keyCode: 0 };

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
    });

    return `Pressed key: ${key}${selector ? ` on ${selector}` : ''}`;
  }

  private async hover(selector: string): Promise<string> {
    if (!selector) return 'Error: selector is required';
    const cdp = await ensureConnected();

    // Get element position
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ error: 'Element not found: ' + ${JSON.stringify(selector)} });
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').substring(0, 50).trim() });
        })()
      `,
      returnByValue: true,
    });

    const val = (result.result as Record<string, unknown>)?.value as string;
    if (!val) return 'Error: could not get element position';

    const info = JSON.parse(val);
    if (info.error) return info.error;

    // Move mouse to element center
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(info.x),
      y: Math.round(info.y),
    });

    return `Hovered over: ${info.tag} "${info.text}"`;
  }

  private async findByText(text: string, tag?: string): Promise<string> {
    if (!text) return 'Error: text is required';
    const cdp = await ensureConnected();

    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const searchText = ${JSON.stringify(text)}.toLowerCase();
          const tagFilter = ${JSON.stringify(tag || '')}.toLowerCase();
          const elements = document.querySelectorAll(tagFilter || '*');
          const matches = [];

          for (const el of elements) {
            // Skip invisible elements
            if (el.offsetParent === null && el.tagName !== 'BODY') continue;

            const elText = (el.textContent || '').trim();
            if (elText.toLowerCase().includes(searchText) && elText.length < 500) {
              // Generate a reliable selector
              let selector = '';
              if (el.id) {
                selector = '#' + el.id;
              } else if (el.getAttribute('data-testid')) {
                selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
              } else if (el.getAttribute('aria-label')) {
                selector = '[aria-label="' + el.getAttribute('aria-label') + '"]';
              } else if (el.getAttribute('role')) {
                selector = el.tagName.toLowerCase() + '[role="' + el.getAttribute('role') + '"]';
              } else {
                // Use tag + class combo
                const classes = Array.from(el.classList).slice(0, 2).join('.');
                selector = el.tagName.toLowerCase() + (classes ? '.' + classes : '');
              }

              matches.push({
                tag: el.tagName.toLowerCase(),
                text: elText.substring(0, 80),
                selector: selector,
                type: el.getAttribute('type') || '',
                role: el.getAttribute('role') || '',
              });

              if (matches.length >= 5) break;
            }
          }

          if (matches.length === 0) return 'No elements found containing: ' + ${JSON.stringify(text)};
          return JSON.stringify(matches);
        })()
      `,
      returnByValue: true,
    });

    const val = (result.result as Record<string, unknown>)?.value as string;
    if (!val || !val.startsWith('[')) return val || 'No elements found';

    const matches = JSON.parse(val);
    return `Found ${matches.length} element(s) matching "${text}":\n` +
      matches.map((m: Record<string, string>, i: number) =>
        `  ${i + 1}. <${m.tag}> "${m.text}"\n     selector: ${m.selector}${m.role ? `  role: ${m.role}` : ''}`
      ).join('\n');
  }

  private async switchTab(index?: number, urlContains?: string): Promise<string> {
    const targets = await getTargets(debugPort);
    const pages = targets.filter(t => t.url && !t.url.startsWith('devtools://'));

    if (pages.length === 0) return 'No tabs available.';

    let target;
    if (index !== undefined) {
      target = pages[index - 1];
      if (!target) return `Tab ${index} not found. ${pages.length} tabs available.`;
    } else if (urlContains) {
      target = pages.find(t => t.url.includes(urlContains));
      if (!target) return `No tab found matching URL "${urlContains}".`;
    } else {
      return 'Error: provide index (1-based) or url to match.';
    }

    // Close current connection and connect to new target
    if (client) {
      client.close();
      client = null;
    }

    client = new CDPClient();
    await client.connect(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    return `Switched to tab: ${target.title || '(no title)'}\n  ${target.url}`;
  }

  private async newTab(url?: string): Promise<string> {
    const cdp = await ensureConnected();
    const targetUrl = url || 'about:blank';

    // Auto-add protocol
    let navUrl = targetUrl;
    if (url && !url.startsWith('http://') && !url.startsWith('https://') && url !== 'about:blank') {
      navUrl = 'https://' + url;
    }

    const result = await cdp.send('Target.createTarget', { url: navUrl });
    const targetId = (result as Record<string, unknown>).targetId as string;

    if (!targetId) return 'Failed to create new tab.';

    // Switch to the new tab
    const targets = await getTargets(debugPort);
    const newTarget = targets.find(t => t.id === targetId);

    if (newTarget?.webSocketDebuggerUrl) {
      client?.close();
      client = new CDPClient();
      await client.connect(newTarget.webSocketDebuggerUrl);
      await client.send('Page.enable');
      await client.send('Runtime.enable');
    }

    return `Opened new tab: ${navUrl}`;
  }
}
