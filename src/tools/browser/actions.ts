/**
 * Browser action implementations — navigate, click, type, screenshot, etc.
 * Extracted from browser.ts for maintainability.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { CDPClient, getTargets } from '../../browser/cdp';
import { ensureConnected, BrowserSession, setLastScreenshotData, getClient, setClient, getDebugPort } from './connection';

export async function navigate(url: string): Promise<string> {
    if (!url) return 'Error: url is required';

    // Auto-add protocol before anything else
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // Fallback mode: use HTTP fetch instead of CDP
    const session = BrowserSession.getInstance();
    if (session.isFallbackMode()) {
      return fetchFallback(url);
    }

    const cdp = await ensureConnected();

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

export async function getContent(): Promise<string> {
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

export async function screenshot(): Promise<string> {
    const cdp = await ensureConnected();
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const data = result.data as string;

    if (!data) return 'Failed to capture screenshot';

    // Save to temp file
    const filePath = path.join(os.tmpdir(), `codebot-screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

    // Store base64 for vision-capable LLMs (v2.1.6)
    setLastScreenshotData(data);

    return `Screenshot saved: ${filePath} (${Math.round(data.length * 0.75 / 1024)}KB)`;
  }

export async function click(selector: string): Promise<string> {
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

export async function typeText(selector: string, text: string): Promise<string> {
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

export async function evaluate(expression: string): Promise<string> {
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

export async function listTabs(): Promise<string> {
  const debugPort = getDebugPort();
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

export function closeBrowser(): string {
  const client = getClient();
  if (client) {
    client.close();
    setClient(null);
  }
  return 'Browser connection closed.';
}

export async function scroll(selector: string | undefined, direction: string, amount: number): Promise<string> {
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

export async function wait(ms: number): Promise<string> {
    const clamped = Math.min(Math.max(ms, 100), 10000);
    await new Promise(r => setTimeout(r, clamped));
    return `Waited ${clamped}ms`;
  }

export async function pressKey(key: string, selector?: string): Promise<string> {
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

export async function hover(selector: string): Promise<string> {
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

export async function findByText(text: string, tag?: string): Promise<string> {
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

export async function switchTab(index?: number, urlContains?: string): Promise<string> {
  const debugPort = getDebugPort();
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
  const currentClient = getClient();
  if (currentClient) {
    currentClient.close();
    setClient(null);
  }

  const newClient = new CDPClient();
  await newClient.connect(target.webSocketDebuggerUrl);
  await newClient.send('Page.enable');
  await newClient.send('Runtime.enable');
  setClient(newClient);

  return `Switched to tab: ${target.title || '(no title)'}\n  ${target.url}`;
}

export async function fetchFallback(url: string): Promise<string> {
    const mod = url.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve) => {
      const req = mod.get(url, { headers: { 'User-Agent': 'CodeBot-AI/2.1.6' }, timeout: 10000 }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          // Strip HTML tags for basic content extraction
          const text = data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 30000);
          resolve(`[Fallback mode — Chrome unavailable, using HTTP fetch]\n\nURL: ${url}\nContent (text only):\n${text}`);
        });
      });
      req.on('error', () => resolve(`Error: Could not fetch ${url}. Check the URL and your network connection.`));
      req.on('timeout', () => { req.destroy(); resolve(`Error: Request to ${url} timed out after 10s.`); });
    });
  }

export async function newTab(url?: string): Promise<string> {
  const cdp = await ensureConnected();
  const debugPort = getDebugPort();
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
    getClient()?.close();
    const newClient = new CDPClient();
    await newClient.connect(newTarget.webSocketDebuggerUrl);
    await newClient.send('Page.enable');
    await newClient.send('Runtime.enable');
    setClient(newClient);
  }

  return `Opened new tab: ${navUrl}`;
}
