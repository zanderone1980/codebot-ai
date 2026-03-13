/**
 * CLI event rendering — tool calls, results, streaming, solve events.
 * Extracted from cli.ts for maintainability.
 */

import { Agent } from '../agent';
import { AgentEvent } from '../types';
import { UI, budgetBar } from '../ui';
import { SolveEvent, SolveResult } from '../solve';
import { RiskScorer } from '../risk';

export let verbose = false;
export function setVerbose(v: boolean) { verbose = v; }

let isThinking = false;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...';
}

export function renderEvent(event: AgentEvent, agent?: Agent) {
  switch (event.type) {
    case 'thinking':
      if (!isThinking) {
        process.stdout.write(UI.dim + '\n\ud83d\udcad ' + UI.reset);
        isThinking = true;
      }
      process.stdout.write(UI.dim + (event.text || '') + UI.reset);
      break;
    case 'text':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      process.stdout.write(event.text || '');
      break;
    case 'tool_call':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      {
        const risk = event.risk || { score: 0, level: 'green' };
        const riskColor = risk.level === 'red' ? UI.red : risk.level === 'orange' ? UI.orange : risk.level === 'yellow' ? UI.yellow : UI.green;
        console.log(`\n${UI.bold}${riskColor}\u26a1${UI.reset} ${UI.bold}${event.toolCall?.name}${UI.reset} ${riskColor}[${risk.score}]${UI.reset}`);
        if (event.toolCall?.args) {
          for (const [k, v] of Object.entries(event.toolCall.args)) {
            const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
            console.log(`${UI.dim}  ${k}: ${val}${UI.reset}`);
          }
        }
      }
      break;
    case 'tool_result':
      if (event.toolResult?.is_error) {
        console.log(`${UI.red}  \u2717 ${truncate(event.toolResult.result, 200)}${UI.reset}`);
      } else {
        const result = event.toolResult?.result || '';
        const lines = result.split('\n');
        if (lines.length > 5 && !verbose) {
          console.log(`${UI.brightGreen}  \u2713${UI.reset} ${UI.dim}(${lines.length} lines, use --verbose to expand)${UI.reset}`);
        } else if (lines.length > 10) {
          console.log(`${UI.brightGreen}  \u2713${UI.reset} ${UI.dim}(${lines.length} lines)${UI.reset}`);
        } else {
          console.log(`${UI.brightGreen}  \u2713${UI.reset} ${truncate(result, 200)}`);
        }
      }
      break;
    case 'usage':
      if (verbose && event.usage && agent) {
        const tracker = agent.getTokenTracker();
        const parts: string[] = [];
        if (event.usage.inputTokens) parts.push(`in: ${event.usage.inputTokens}`);
        if (event.usage.outputTokens) parts.push(`out: ${event.usage.outputTokens}`);
        if (parts.length > 0) {
          console.log(UI.dim + `  [${parts.join(', ')} tokens | ${tracker.formatCost()}]` + UI.reset);
        }
        const costSoFar = tracker.getTotalCost();
        const costLimit2 = agent.getPolicyEnforcer().getCostLimitUsd();
        if (costLimit2 > 0) {
          console.log(`  ${budgetBar(costSoFar, costLimit2)}`);
        }
      }
      break;
    case 'compaction':
      console.log(UI.dim + `\n\ud83d\udce6 ${event.text}` + UI.reset);
      break;
    case 'error':
      console.error(UI.red + `\n\u2717 ${event.error}` + UI.reset);
      break;
    case 'stream_progress':
      break;
    case 'done':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      break;
  }
}

const SC = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
};

function sc(text: string, style: keyof typeof SC): string {
  return `${SC[style]}${text}${SC.reset}`;
}

export function renderSolveEvent(event: SolveEvent, jsonMode: boolean): void {
  if (jsonMode && event.type === 'result' && event.result) {
    console.log(JSON.stringify(event.result, null, 2));
    return;
  }

  switch (event.type) {
    case 'phase_start':
      console.log(sc(`  >> ${event.phase}: ${event.message}`, 'cyan'));
      break;
    case 'phase_end':
      console.log(sc(`     Done: ${event.message}`, 'green'));
      break;
    case 'progress':
      console.log(sc(`     ${event.message}`, 'dim'));
      break;
    case 'agent_event':
      if (event.agentEvent?.type === 'text' && event.agentEvent.text) {
        process.stdout.write(event.agentEvent.text);
      } else if (event.agentEvent?.type === 'tool_call' && event.agentEvent.toolCall) {
        console.log(sc(`     [tool] ${event.agentEvent.toolCall.name}`, 'dim'));
      } else if (event.agentEvent?.type === 'tool_result' && event.agentEvent.toolResult) {
        const r = event.agentEvent.toolResult;
        const preview = r.result.substring(0, 80).replace(/\n/g, ' ');
        console.log(sc(`     [result] ${r.name}: ${preview}${r.result.length > 80 ? '...' : ''}`, 'dim'));
      }
      break;
    case 'error':
      console.error(sc(`  \u2717 Error: ${event.error}`, 'red'));
      break;
    case 'result':
      if (event.result) {
        renderSolveResult(event.result);
      }
      break;
  }
}

export function renderSolveResult(r: SolveResult): void {
  const lines = [
    '',
    sc('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550', 'cyan'),
    sc('  SOLVE RESULT', 'bold'),
    sc('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550', 'cyan'),
    `  Session:    ${r.sessionId}`,
    `  Issue:      #${r.issue.number} "${r.issue.title}"`,
    `  Repo:       ${r.issue.owner}/${r.issue.repo}`,
    `  Branch:     ${r.branch}`,
    `  Files:      ${r.filesModified.length} changed`,
  ];

  if (r.filesModified.length > 0) {
    for (const f of r.filesModified) {
      lines.push(`              - ${f}`);
    }
  }

  lines.push(`  Tests:      ${r.testsPassed ? sc('PASSED', 'green') : r.testsOutput ? sc('FAILED', 'red') : sc('N/A', 'cyan')}`);
  lines.push(`  Confidence: ${r.confidence}%`);
  lines.push(`  Risk:       ${r.risk}`);
  lines.push(`  Duration:   ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`  Tokens:     ${r.tokensUsed.toLocaleString()}`);
  lines.push(`  Cost:       ${r.cost}`);

  if (r.prUrl) {
    lines.push(`  PR:         ${sc(r.prUrl, 'cyan')}`);
  }

  lines.push(sc('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550', 'cyan'));
  lines.push('');

  console.log(lines.join('\n'));
}
