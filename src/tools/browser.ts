import { Tool } from '../types';
import { CDPClient, getDebuggerUrl, getTargets } from '../browser/cdp';
import { execSync } from 'child_process';

// Shared browser instance across tool calls
let client: CDPClient | null = null;
let debugPort = 9222;

async function ensureConnected(): Promise<CDPClient> {
  if (client?.isConnected()) return client;

  // Try connecting to existing Chrome
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
    // Chrome not running with debugging — try to launch it
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
  for (const chromePath of chromePaths) {
    try {
      execSync(
        `"${chromePath}" --remote-debugging-port=${debugPort} --no-first-run --no-default-browser-check about:blank &`,
        { stdio: 'ignore', timeout: 5000 }
      );
      launched = true;
      break;
    } catch {
      continue;
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

  // Wait for Chrome to start
  for (let i = 0; i < 10; i++) {
    try {
      await new Promise(r => setTimeout(r, 500));
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
  description = 'Control a web browser. Navigate to URLs, read page content, click elements, type text, run JavaScript, take screenshots. Use for web browsing, social media, testing, and automation.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: ['navigate', 'content', 'screenshot', 'click', 'type', 'evaluate', 'tabs', 'close'],
      },
      url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
      selector: { type: 'string', description: 'CSS selector for element (for click/type)' },
      text: { type: 'string', description: 'Text to type (for type action)' },
      expression: { type: 'string', description: 'JavaScript to evaluate (for evaluate action)' },
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
        default:
          return `Unknown action: ${action}. Use: navigate, content, screenshot, click, type, evaluate, tabs, close`;
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

    await cdp.send('Page.navigate', { url });

    // Wait for page load
    await new Promise(r => setTimeout(r, 2000));

    // Get page title
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const title = (result.result as Record<string, unknown>)?.value || 'untitled';

    return `Navigated to: ${url}\nTitle: ${title}`;
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
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
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
          if (!el) return 'Element not found: ${selector}';
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

    // Focus the element
    await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) { el.focus(); el.value = ''; }
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

    // Also set value directly as fallback
    await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
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
}
