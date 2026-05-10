/**
 * CLI event rendering — tool calls, results, streaming, solve events.
 * Extracted from cli.ts for maintainability.
 */

import { Agent } from '../agent';
import { AgentEvent } from '../types';
import { UI, budgetBar } from '../ui';
import { SolveEvent, SolveResult } from '../solve';

export let verbose = false;
export function setVerbose(v: boolean) { verbose = v; }

let isThinking = false;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...';
}

// ── Per-event-type renderers ─────────────────────────────────────────────────

function renderThinking(text: string) {
  if (!isThinking) {
    process.stdout.write(UI.dim + '\n💭 ' + UI.reset);
    isThinking = true;
  }
  process.stdout.write(UI.dim + (text || '') + UI.reset);
}

function renderText(text: string) {
  if (isThinking) {
    process.stdout.write('\n');
    isThinking = false;
  }
  process.stdout.write(text || '');
}

function renderToolCall(event: AgentEvent) {
  if (isThinking) {
    process.stdout.write('\n');
    isThinking = false;
  }
  const risk = event.risk || { score: 0, level: 'green' };
  const riskColor = risk.level === 'red' ? UI.red : risk.level === 'orange' ? UI.orange : risk.level === 'yellow' ? UI.yellow : UI.green;
  console.log(`\n${UI.bold}${riskColor}⚡${UI.reset} ${UI.bold}${event.toolCall?.name}${UI.reset} ${riskColor}[${risk.score}]${UI.reset}`);
  if (event.toolCall?.args) {
    for (const [k, v] of Object.entries(event.toolCall.args)) {
      const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
      console.log(`${UI.dim}  ${k}: ${val}${UI.reset}`);
    }
  }
}

function renderToolResult(event: AgentEvent) {
  if (event.toolResult?.is_error) {
    console.log(`${UI.red}  ✗ ${truncate(event.toolResult.result, 200)}${UI.reset}`);
    return;
  }
  const result = event.toolResult?.result || '';
  const lines = result.split('\n');
  if (lines.length > 5 && !verbose) {
    console.log(`${UI.brightGreen}  ✓${UI.reset} ${UI.dim}(${lines.length} lines, use --verbose to expand)${UI.reset}`);
  } else if (lines.length > 10) {
    console.log(`${UI.brightGreen}  ✓${UI.reset} ${UI.dim}(${lines.length} lines)${UI.reset}`);
  } else {
    console.log(`${UI.brightGreen}  ✓${UI.reset} ${truncate(result, 200)}`);
  }
}

function renderUsage(event: AgentEvent, agent?: Agent) {
  if (!verbose || !event.usage || !agent) return;
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

// ── Main dispatcher ──────────────────────────────────────────────────────────

export function renderEvent(event: AgentEvent, agent?: Agent) {
  switch (event.type) {
    case 'thinking':
      renderThinking(event.text || '');
      break;
    case 'text':
      renderText(event.text || '');
      break;
    case 'tool_call':
      renderToolCall(event);
      break;
    case 'tool_result':
      renderToolResult(event);
      break;
    case 'usage':
      renderUsage(event, agent);
      break;
    case 'compaction':
      console.log(UI.dim + `\n📦 ${event.text}` + UI.reset);
      break;
    case 'error':
      console.error(UI.red + `\n✗ ${event.error}` + UI.reset);
      if (verbose && (event as any).stack) {
        console.error(UI.dim + (event as any).stack + UI.reset);
      }
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
      renderSolveAgentEvent(event);
      break;
    case 'error':
      console.error(sc(`  ✗ Error: ${event.error}`, 'red'));
      break;
    case 'result':
      if (event.result) {
        renderSolveResult(event.result);
      }
      break;
  }
}

function renderSolveAgentEvent(event: SolveEvent) {
  if (event.agentEvent?.type === 'text' && event.agentEvent.text) {
    process.stdout.write(event.agentEvent.text);
  } else if (event.agentEvent?.type === 'tool_call' && event.agentEvent.toolCall) {
    console.log(sc(`     [tool] ${event.agentEvent.toolCall.name}`, 'dim'));
  } else if (event.agentEvent?.type === 'tool_result' && event.agentEvent.toolResult) {
    const r = event.agentEvent.toolResult;
    const preview = r.result.substring(0, 80).replace(/\n/g, ' ');
    console.log(sc(`     [result] ${r.name}: ${preview}${r.result.length > 80 ? '...' : ''}`, 'dim'));
  }
}

export function renderSolveResult(r: SolveResult): void {
  const lines = [
    '',
    sc('  ═══════════════════════════════════════════', 'cyan'),
    sc('  SOLVE RESULT', 'bold'),
    sc('  ═══════════════════════════════════════════', 'cyan'),
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

  // Surface the audit trail — the marquee feature, not buried in a file.
  if (r.auditPath) {
    const { AuditLogger } = require('../audit') as typeof import('../audit');
    try {
      const { existsSync, readFileSync } = require('fs') as typeof import('fs');
      if (existsSync(r.auditPath)) {
        // Count entries in the solve audit JSON (not the AuditLogger JSONL)
        const solveAudit = JSON.parse(readFileSync(r.auditPath, 'utf-8'));
        const entryCount = (solveAudit.entries || []).length;
        lines.push(`  Audit:      ${sc(`${entryCount} actions recorded`, 'green')} — ${r.auditPath}`);
      }
    } catch { /* best-effort */ }

    // Verify the main AuditLogger chain for this session.
    try {
      const logger = new AuditLogger();
      const verify = logger.verifySession(r.sessionId);
      if (verify.valid) {
        lines.push(`  Chain:      ${sc(`✓ verified (${verify.entriesChecked} entries, hash chain intact)`, 'green')}`);
      } else if (!verify.legacy) {
        lines.push(`  Chain:      ${sc(`⚠ ${verify.reason}`, 'dim')}`);
      }
    } catch { /* best-effort */ }
  }

  lines.push(sc('  ═══════════════════════════════════════════', 'cyan'));
  lines.push('');

  console.log(lines.join('\n'));
}
