/**
 * CodeBot AI — TUI Mode
 *
 * Full-screen interactive terminal UI for agent operation.
 * Routes agent events to panels, handles keyboard input,
 * manages permission approval flow in-panel.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

import { Agent } from '../agent';
import { AgentEvent } from '../types';
import { LayoutEngine } from './layout';
import { createKeyboardListener, keyToAction, KeyEvent, TuiAction } from './keyboard';

/** Step status for the plan panel */
export interface TuiStep {
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

/** TUI mode configuration */
export interface TuiConfig {
  /** Custom status bar text */
  statusText?: string;
  /** Auto-approve tool calls (autonomous mode in TUI) */
  autoApprove?: boolean;
  /** Split ratio for left panel (0-1) */
  splitRatio?: number;
}

/**
 * TuiMode — full-screen agent interaction.
 *
 * Creates a 3-panel layout:
 * - Left: Plan panel (steps + progress)
 * - Right-top: Logs panel (agent text output)
 * - Right-bottom: Diff/Output panel (tool results)
 *
 * Keyboard:
 * - Tab: cycle focus between panels
 * - ↑↓: scroll focused panel
 * - y: approve pending tool call
 * - n: deny pending tool call
 * - s: skip pending tool call
 * - q: quit TUI mode
 */
export class TuiMode {
  private layout: LayoutEngine;
  private agent: Agent;
  private config: TuiConfig;
  private steps: TuiStep[] = [];
  private pendingApproval: {
    tool: string;
    args: Record<string, unknown>;
    resolve: (approved: boolean) => void;
  } | null = null;
  private running: boolean = false;
  private keyboardCleanup: (() => void) | null = null;

  constructor(agent: Agent, config?: TuiConfig) {
    this.agent = agent;
    this.config = config || {};

    this.layout = new LayoutEngine({
      splitRatio: config?.splitRatio ?? 0.35,
      bottomPanelHeight: 10,
    });

    // Create panels
    this.layout.addPanel('plan', 'Plan', { maxScrollback: 500 });
    this.layout.addPanel('logs', 'Output', { maxScrollback: 2000 });
    this.layout.addPanel('diff', 'Details', { maxScrollback: 500 });

    // Set initial status
    this.layout.setStatus(
      config?.statusText || 'Tab: panel | ↑↓: scroll | y: approve | n: deny | q: quit | ?: help'
    );

    // Wire up the agent's permission callback
    this.agent.setAskPermission(this.handlePermission.bind(this));
  }

  /** Start TUI mode — enters alt screen and begins keyboard handling */
  async start(): Promise<void> {
    const screen = this.layout.getScreen();
    screen.enter();
    this.running = true;

    // Initial render
    this.addPlanStep('Waiting for input...');
    this.renderAll();

    // Start keyboard listener
    const { events, cleanup } = createKeyboardListener();
    this.keyboardCleanup = cleanup;

    // Process keyboard events in background
    this.processKeyboard(events);
  }

  /** Stop TUI mode — exits alt screen and restores terminal */
  stop(): void {
    this.running = false;
    if (this.keyboardCleanup) {
      this.keyboardCleanup();
      this.keyboardCleanup = null;
    }
    const screen = this.layout.getScreen();
    screen.exit();
  }

  /** Process a user message through the agent and route events to panels */
  async processMessage(message: string): Promise<void> {
    this.steps = [];
    this.addPlanStep('Processing: ' + (message.length > 40 ? message.substring(0, 40) + '...' : message));
    this.markStepActive(0);

    this.layout.appendLine('logs', `\x1b[1m> ${message}\x1b[0m`);
    this.layout.appendLine('logs', '');
    this.renderAll();

    let stepCount = 0;

    try {
      for await (const event of this.agent.run(message)) {
        if (!this.running) break;
        this.handleEvent(event, stepCount);
        stepCount++;
        this.renderAll();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.layout.appendLine('logs', `\x1b[31m✗ Fatal: ${msg}\x1b[0m`);
      this.renderAll();
    }

    // Mark last step as done
    if (this.steps.length > 0) {
      const last = this.steps[this.steps.length - 1];
      if (last.status === 'active') last.status = 'done';
    }
    this.updatePlanPanel();
    this.renderAll();
  }

  /** Check if TUI is still running */
  isRunning(): boolean {
    return this.running;
  }

  // ── Event routing ──

  private handleEvent(event: AgentEvent, _stepIdx: number): void {
    switch (event.type) {
      case 'thinking':
        this.layout.appendLine('logs', `\x1b[2m💭 ${event.text || ''}\x1b[0m`);
        break;

      case 'text':
        // Append text tokens (accumulate on same line for streaming)
        if (event.text) {
          const logs = this.layout.getPanel('logs');
          if (logs && logs.content.length > 0) {
            const lastLine = logs.content[logs.content.length - 1];
            // If last line was a text token (no prefix), append to it
            if (!lastLine.startsWith('\x1b[')) {
              logs.content[logs.content.length - 1] = lastLine + event.text;
            } else {
              this.layout.appendLine('logs', event.text);
            }
          } else {
            this.layout.appendLine('logs', event.text);
          }
        }
        break;

      case 'tool_call': {
        const name = event.toolCall?.name || 'unknown';
        const riskStr = event.risk ? ` (risk: ${event.risk.score})` : '';
        this.addPlanStep(`${name}${riskStr}`);
        this.markStepActive(this.steps.length - 1);

        // Show args in diff panel
        this.layout.updateContent('diff', [
          `\x1b[1mTool: ${name}\x1b[0m`,
          `\x1b[2mRisk: ${event.risk?.score ?? '?'} (${event.risk?.level ?? '?'})\x1b[0m`,
          '',
          ...this.formatArgs(event.toolCall?.args || {}),
        ]);
        break;
      }

      case 'tool_result': {
        const name = event.toolResult?.name || 'unknown';
        const isError = event.toolResult?.is_error;
        const lastStep = this.steps[this.steps.length - 1];
        if (lastStep) {
          lastStep.status = isError ? 'failed' : 'done';
        }

        // Show result in diff panel
        const result = event.toolResult?.result || '';
        const resultLines = result.split('\n').slice(0, 50);
        const prefix = isError ? '\x1b[31m✗' : '\x1b[32m✓';
        this.layout.appendLine('logs', `  ${prefix} ${name}\x1b[0m`);

        this.layout.updateContent('diff', [
          `${prefix} ${name}\x1b[0m`,
          '',
          ...resultLines,
        ]);
        break;
      }

      case 'usage':
        // Silently track (shown in status bar)
        break;

      case 'stream_progress':
        if (event.streamProgress) {
          this.layout.setStatus(
            `Streaming: ${event.streamProgress.tokensGenerated} tokens (${event.streamProgress.tokensPerSecond} tok/s) | Tab: panel | q: quit`
          );
        }
        break;

      case 'compaction':
        this.layout.appendLine('logs', `\x1b[2m📦 ${event.text}\x1b[0m`);
        break;

      case 'error':
        this.layout.appendLine('logs', `\x1b[31m✗ ${event.error}\x1b[0m`);
        const lastStep = this.steps[this.steps.length - 1];
        if (lastStep && lastStep.status === 'active') {
          lastStep.status = 'failed';
        }
        break;

      case 'done':
        this.layout.setStatus('Done | Tab: panel | ↑↓: scroll | q: quit');
        break;
    }

    this.updatePlanPanel();
  }

  // ── Keyboard handling ──

  private async processKeyboard(events: AsyncGenerator<KeyEvent>): Promise<void> {
    for await (const event of events) {
      if (!this.running) break;
      const action = keyToAction(event);
      this.handleAction(action);
      this.renderAll();
    }
  }

  private handleAction(action: TuiAction): void {
    switch (action) {
      case 'scroll_up': {
        const focusedId = this.layout.getFocusedId();
        if (focusedId) this.layout.scroll(focusedId, -3);
        break;
      }
      case 'scroll_down': {
        const focusedId = this.layout.getFocusedId();
        if (focusedId) this.layout.scroll(focusedId, 3);
        break;
      }
      case 'focus_next':
        this.layout.focusNext();
        break;
      case 'focus_prev':
        this.layout.focusPrev();
        break;
      case 'approve':
        if (this.pendingApproval) {
          this.pendingApproval.resolve(true);
          this.layout.appendLine('logs', '\x1b[32m✓ Approved\x1b[0m');
          this.pendingApproval = null;
        }
        break;
      case 'deny':
        if (this.pendingApproval) {
          this.pendingApproval.resolve(false);
          this.layout.appendLine('logs', '\x1b[31m✗ Denied\x1b[0m');
          this.pendingApproval = null;
        }
        break;
      case 'skip':
        if (this.pendingApproval) {
          this.pendingApproval.resolve(false);
          this.layout.appendLine('logs', '\x1b[33m⊘ Skipped\x1b[0m');
          const lastStep = this.steps[this.steps.length - 1];
          if (lastStep) lastStep.status = 'skipped';
          this.pendingApproval = null;
        }
        break;
      case 'quit':
        this.stop();
        break;
      case 'help':
        this.showHelp();
        break;
    }
  }

  // ── Permission handling ──

  private handlePermission(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { tool, args, resolve };

      // Show approval dialog in diff panel
      this.layout.updateContent('diff', [
        '\x1b[1m\x1b[33m⚡ PERMISSION REQUIRED\x1b[0m',
        '',
        `\x1b[1mTool:\x1b[0m  ${tool}`,
        '',
        ...this.formatArgs(args),
        '',
        '\x1b[1m[y]\x1b[0m Approve   \x1b[1m[n]\x1b[0m Deny   \x1b[1m[s]\x1b[0m Skip',
      ]);

      this.layout.setStatus(
        `⚡ ${tool} — Press y to approve, n to deny, s to skip`
      );

      this.layout.focus('diff');
      this.renderAll();
    });
  }

  // ── Helper methods ──

  private addPlanStep(label: string): void {
    this.steps.push({ label, status: 'pending' });
    this.updatePlanPanel();
  }

  private markStepActive(index: number): void {
    if (index < this.steps.length) {
      // Mark previous active steps as done
      for (let i = 0; i < index; i++) {
        if (this.steps[i].status === 'active') {
          this.steps[i].status = 'done';
        }
      }
      this.steps[index].status = 'active';
    }
    this.updatePlanPanel();
  }

  private updatePlanPanel(): void {
    const lines: string[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      let icon: string;
      switch (step.status) {
        case 'pending': icon = '\x1b[2m○\x1b[0m'; break;
        case 'active': icon = '\x1b[36m◉\x1b[0m'; break;
        case 'done': icon = '\x1b[32m✓\x1b[0m'; break;
        case 'failed': icon = '\x1b[31m✗\x1b[0m'; break;
        case 'skipped': icon = '\x1b[33m⊘\x1b[0m'; break;
      }
      lines.push(` ${icon} ${step.label}`);
      if (step.detail) {
        lines.push(`   \x1b[2m${step.detail}\x1b[0m`);
      }
    }
    this.layout.updateContent('plan', lines);
  }

  private formatArgs(args: Record<string, unknown>): string[] {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      let val: string;
      if (typeof v === 'string') {
        val = v.length > 60 ? v.substring(0, 60) + '...' : v;
      } else {
        const s = JSON.stringify(v);
        val = s.length > 60 ? s.substring(0, 60) + '...' : s;
      }
      lines.push(`\x1b[2m${k}:\x1b[0m ${val}`);
    }
    return lines;
  }

  private showHelp(): void {
    this.layout.updateContent('diff', [
      '\x1b[1mTUI Keyboard Shortcuts\x1b[0m',
      '',
      '  Tab        Cycle focus between panels',
      '  ↑ / ↓      Scroll focused panel',
      '  y          Approve tool call',
      '  n          Deny tool call',
      '  s          Skip tool call',
      '  r          Retry last action',
      '  ?  or  h   Show this help',
      '  q          Quit TUI mode',
      '',
      '\x1b[2mPress any key to dismiss\x1b[0m',
    ]);
    this.renderAll();
  }

  private renderAll(): void {
    this.layout.renderToScreen();
  }
}
