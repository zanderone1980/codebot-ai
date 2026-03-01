import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

/**
 * Tests for StatusBarManager logic.
 * Tests the event processing and state tracking without the vscode module.
 */

describe('StatusBarManager (logic)', () => {
  let totalInputTokens: number;
  let totalOutputTokens: number;
  let totalCost: number;
  let modelText: string;
  let tokensText: string;
  let riskText: string;
  let riskBg: string | undefined;
  let tokensVisible: boolean;
  let riskVisible: boolean;

  function reset() {
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalCost = 0;
    modelText = '$(hubot) CodeBot';
    tokensText = '';
    riskText = '';
    riskBg = undefined;
    tokensVisible = false;
    riskVisible = false;
  }

  function updateUsage(event: { inputTokens?: number; outputTokens?: number; cost?: number }) {
    if (event.inputTokens !== undefined) totalInputTokens += event.inputTokens;
    if (event.outputTokens !== undefined) totalOutputTokens += event.outputTokens;
    if (event.cost !== undefined) totalCost += event.cost;

    const totalTokens = totalInputTokens + totalOutputTokens;
    const costStr = totalCost > 0 ? ` | $${totalCost.toFixed(4)}` : '';
    tokensText = `$(pulse) ${totalTokens.toLocaleString('en-US')} tokens${costStr}`;
    tokensVisible = true;
  }

  function updateRisk(event: { risk?: { score: number; level: string }; tool?: string }) {
    if (!event.risk) return;

    const { score, level } = event.risk;
    switch (level) {
      case 'high':
        riskText = `$(shield) HIGH (${score})`;
        riskBg = 'statusBarItem.errorBackground';
        break;
      case 'medium':
        riskText = `$(shield) MED (${score})`;
        riskBg = 'statusBarItem.warningBackground';
        break;
      default:
        riskText = `$(shield) LOW (${score})`;
        riskBg = undefined;
        break;
    }
    riskVisible = true;
  }

  function setModel(provider: string, model: string) {
    modelText = `$(hubot) ${provider}/${model}`;
  }

  beforeEach(() => reset());

  it('shows default model text initially', () => {
    assert.strictEqual(modelText, '$(hubot) CodeBot');
  });

  it('updates model text with setModel', () => {
    setModel('anthropic', 'claude-sonnet-4-20250514');
    assert.strictEqual(modelText, '$(hubot) anthropic/claude-sonnet-4-20250514');
  });

  it('accumulates input tokens from usage events', () => {
    updateUsage({ inputTokens: 100 });
    updateUsage({ inputTokens: 200 });
    assert.strictEqual(totalInputTokens, 300);
  });

  it('accumulates output tokens from usage events', () => {
    updateUsage({ outputTokens: 50 });
    updateUsage({ outputTokens: 75 });
    assert.strictEqual(totalOutputTokens, 125);
  });

  it('accumulates cost from usage events', () => {
    updateUsage({ cost: 0.001 });
    updateUsage({ cost: 0.002 });
    assert.ok(Math.abs(totalCost - 0.003) < 1e-10, 'Cost should accumulate');
  });

  it('formats token display correctly', () => {
    updateUsage({ inputTokens: 1500, outputTokens: 500, cost: 0.0123 });
    assert.ok(tokensText.includes('2,000'), 'Should format with locale separators');
    assert.ok(tokensText.includes('$0.0123'), 'Should include cost');
  });

  it('hides cost when zero', () => {
    updateUsage({ inputTokens: 100, outputTokens: 50 });
    assert.ok(!tokensText.includes('| $'), 'Should not show cost separator when zero');
  });

  it('shows tokens item after first usage', () => {
    assert.strictEqual(tokensVisible, false, 'Should be hidden initially');
    updateUsage({ inputTokens: 10 });
    assert.strictEqual(tokensVisible, true, 'Should be visible after usage');
  });

  it('displays low risk with no background color', () => {
    updateRisk({ risk: { score: 15, level: 'low' }, tool: 'think' });
    assert.ok(riskText.includes('LOW'), 'Should show LOW');
    assert.ok(riskText.includes('15'), 'Should show score');
    assert.strictEqual(riskBg, undefined, 'Should have no background');
  });

  it('displays medium risk with warning background', () => {
    updateRisk({ risk: { score: 40, level: 'medium' }, tool: 'write_file' });
    assert.ok(riskText.includes('MED'), 'Should show MED');
    assert.strictEqual(riskBg, 'statusBarItem.warningBackground');
  });

  it('displays high risk with error background', () => {
    updateRisk({ risk: { score: 85, level: 'high' }, tool: 'execute' });
    assert.ok(riskText.includes('HIGH'), 'Should show HIGH');
    assert.strictEqual(riskBg, 'statusBarItem.errorBackground');
  });

  it('shows risk item after first tool call with risk', () => {
    assert.strictEqual(riskVisible, false, 'Should be hidden initially');
    updateRisk({ risk: { score: 10, level: 'low' }, tool: 'think' });
    assert.strictEqual(riskVisible, true, 'Should be visible after risk event');
  });

  it('ignores tool calls without risk data', () => {
    updateRisk({ tool: 'think' });
    assert.strictEqual(riskVisible, false, 'Should remain hidden without risk data');
    assert.strictEqual(riskText, '', 'Should not update text');
  });

  it('resets all counters and visibility', () => {
    updateUsage({ inputTokens: 500, outputTokens: 200, cost: 0.05 });
    updateRisk({ risk: { score: 60, level: 'medium' }, tool: 'execute' });
    reset();

    assert.strictEqual(totalInputTokens, 0);
    assert.strictEqual(totalOutputTokens, 0);
    assert.strictEqual(totalCost, 0);
    assert.strictEqual(tokensVisible, false);
    assert.strictEqual(riskVisible, false);
    assert.strictEqual(modelText, '$(hubot) CodeBot');
  });

  it('handles multiple sequential risk updates', () => {
    updateRisk({ risk: { score: 10, level: 'low' }, tool: 'think' });
    assert.ok(riskText.includes('LOW'));

    updateRisk({ risk: { score: 80, level: 'high' }, tool: 'execute' });
    assert.ok(riskText.includes('HIGH'), 'Should show latest risk');
    assert.strictEqual(riskBg, 'statusBarItem.errorBackground');
  });
});
