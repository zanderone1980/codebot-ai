import { Tool, CapabilityLabel } from '../types';
import { PolicyEnforcer } from '../policy';
import {
  BrowserSession,
  ensureConnected,
  killExistingChrome,
  lastScreenshotData,
  setLastScreenshotData,
  getClient,
  setClient,
  getDebugPort,
} from './browser/connection';
import {
  navigate,
  getContent,
  screenshot,
  click,
  typeText,
  evaluate,
  listTabs,
  closeBrowser,
  scroll,
  wait,
  pressKey,
  hover,
  findByText,
  switchTab,
  fetchFallback,
  newTab,
} from './browser/actions';

// Re-export for backwards compatibility
export { BrowserSession, lastScreenshotData };

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Control a web browser. Navigate to URLs, read page content, click elements, type text, scroll, press keys, find elements by text, hover, manage tabs, run JavaScript, and take screenshots. Use for web browsing, social media, email, research, testing, and automation.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['browser-read', 'browser-write', 'net-fetch'];
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

    // RBAC: check if browser tool is allowed for the current user
    try {
      const enforcer = new PolicyEnforcer();
      const toolCheck = enforcer.isToolAllowed('browser');
      if (!toolCheck.allowed) {
        return `Blocked by policy: ${toolCheck.reason}`;
      }
    } catch { /* no policy — proceed with defaults */ }

    try {
      switch (action) {
        case 'navigate':
          return await navigate(args.url as string);
        case 'content':
          return await getContent();
        case 'screenshot':
          return await screenshot();
        case 'click':
          return await click(args.selector as string);
        case 'type':
          return await typeText(args.selector as string, args.text as string);
        case 'evaluate':
          return await evaluate(args.expression as string);
        case 'tabs':
          return await listTabs();
        case 'close':
          return closeBrowser();
        case 'scroll':
          return await scroll(args.selector as string | undefined, args.direction as string || 'down', args.amount as number || 400);
        case 'wait':
          return await wait(args.amount as number || 1000);
        case 'press_key':
          return await pressKey(args.key as string, args.selector as string | undefined);
        case 'hover':
          return await hover(args.selector as string);
        case 'find_by_text':
          return await findByText(args.text as string, args.tag as string | undefined);
        case 'switch_tab':
          return await switchTab(args.index as number | undefined, args.url as string | undefined);
        case 'new_tab':
          return await newTab(args.url as string | undefined);
        default:
          return `Unknown action: ${action}. Available: navigate, content, screenshot, click, type, evaluate, tabs, close, scroll, wait, press_key, hover, find_by_text, switch_tab, new_tab`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Browser error: ${msg}`;
    }
  }
}
