import * as vscode from 'vscode';
import type { AgentEvent } from 'codebot-ai';

/**
 * Manages status bar items that display real-time agent information:
 * - Current model name
 * - Token usage and estimated cost
 * - Risk level indicator
 */
export class StatusBarManager {
  private readonly modelItem: vscode.StatusBarItem;
  private readonly tokensItem: vscode.StatusBarItem;
  private readonly riskItem: vscode.StatusBarItem;

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCost = 0;

  constructor() {
    // Model indicator (leftmost)
    this.modelItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.modelItem.name = 'CodeBot Model';
    this.modelItem.tooltip = 'CodeBot AI - Current Model';
    this.modelItem.command = 'codebot.showUsage';
    this.modelItem.text = '$(hubot) CodeBot';
    this.modelItem.show();

    // Token / cost counter
    this.tokensItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.tokensItem.name = 'CodeBot Tokens';
    this.tokensItem.tooltip = 'Token usage and estimated cost';
    this.tokensItem.command = 'codebot.showUsage';
    this.tokensItem.hide(); // Hidden until first usage event

    // Risk level indicator
    this.riskItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    this.riskItem.name = 'CodeBot Risk';
    this.riskItem.tooltip = 'Latest tool call risk level';
    this.riskItem.hide(); // Hidden until first tool call with risk
  }

  /**
   * Updates the status bar items based on an incoming agent event.
   */
  public update(event: AgentEvent): void {
    switch (event.type) {
      case 'usage':
        this.updateUsage(event);
        break;

      case 'tool_call':
        this.updateRisk(event);
        break;

      case 'done':
        // Keep the final stats visible
        break;

      case 'error':
        this.riskItem.text = '$(warning) Error';
        this.riskItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        this.riskItem.show();
        break;
    }
  }

  /**
   * Updates the token/cost display from a usage event.
   */
  private updateUsage(event: AgentEvent & { type: 'usage' }): void {
    const usageEvent = event as AgentEvent & {
      inputTokens?: number;
      outputTokens?: number;
      cost?: number;
    };

    if (usageEvent.inputTokens !== undefined) {
      this.totalInputTokens += usageEvent.inputTokens;
    }
    if (usageEvent.outputTokens !== undefined) {
      this.totalOutputTokens += usageEvent.outputTokens;
    }
    if (usageEvent.cost !== undefined) {
      this.totalCost += usageEvent.cost;
    }

    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    const tokenStr = this.formatNumber(totalTokens);
    const costStr = this.totalCost > 0 ? ` | $${this.totalCost.toFixed(4)}` : '';

    this.tokensItem.text = `$(pulse) ${tokenStr} tokens${costStr}`;
    this.tokensItem.tooltip = [
      `Input tokens: ${this.formatNumber(this.totalInputTokens)}`,
      `Output tokens: ${this.formatNumber(this.totalOutputTokens)}`,
      `Total tokens: ${tokenStr}`,
      this.totalCost > 0 ? `Estimated cost: $${this.totalCost.toFixed(4)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.tokensItem.show();
  }

  /**
   * Updates the risk indicator from a tool_call event.
   */
  private updateRisk(event: AgentEvent): void {
    const toolEvent = event as AgentEvent & {
      risk?: { score: number; level: string };
      tool?: string;
      name?: string;
    };

    if (!toolEvent.risk) {
      return;
    }

    const { score, level } = toolEvent.risk;
    const toolName = toolEvent.tool || toolEvent.name || 'unknown';

    let icon: string;
    let bgColor: vscode.ThemeColor | undefined;

    switch (level) {
      case 'high':
        icon = '$(shield) HIGH';
        bgColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'medium':
        icon = '$(shield) MED';
        bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      default:
        icon = '$(shield) LOW';
        bgColor = undefined;
        break;
    }

    this.riskItem.text = `${icon} (${score})`;
    this.riskItem.tooltip = `Risk: ${level} (score: ${score})\nTool: ${toolName}`;
    this.riskItem.backgroundColor = bgColor;
    this.riskItem.show();
  }

  /**
   * Sets the displayed model name.
   */
  public setModel(provider: string, model: string): void {
    this.modelItem.text = `$(hubot) ${provider}/${model}`;
    this.modelItem.tooltip = `CodeBot AI - ${provider} / ${model}`;
  }

  /**
   * Resets all counters and hides dynamic items.
   */
  public reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCost = 0;
    this.tokensItem.hide();
    this.riskItem.hide();
    this.modelItem.text = '$(hubot) CodeBot';
  }

  /**
   * Formats a number with locale-appropriate separators.
   */
  private formatNumber(n: number): string {
    return n.toLocaleString('en-US');
  }

  /**
   * Disposes all status bar items.
   */
  public dispose(): void {
    this.modelItem.dispose();
    this.tokensItem.dispose();
    this.riskItem.dispose();
  }
}
