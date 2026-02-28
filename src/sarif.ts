/**
 * SARIF 2.1.0 Export for CodeBot v1.9.0
 *
 * Converts AuditEntry[] to SARIF 2.1.0 JSON (Static Analysis Results
 * Interchange Format). Only security-relevant entries become results;
 * successful executes are excluded.
 *
 * Rule mapping:
 *   security_block  → CB001 / error
 *   policy_block    → CB002 / warning
 *   capability_block → CB003 / warning
 *   error           → CB004 / note
 *   deny            → CB005 / note
 *
 * Usage: codebot --export-audit sarif [session-id] > results.sarif
 *
 * NEVER throws — export failures must not crash the agent.
 */

import type { AuditEntry } from './audit';

// ── SARIF Types ──

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
  invocations: SarifInvocation[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
}

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
  };
}

export interface SarifInvocation {
  executionSuccessful: boolean;
  startTimeUtc?: string;
  endTimeUtc?: string;
  properties?: Record<string, unknown>;
}

export interface SarifExportOptions {
  version?: string;
  sessionId?: string;
  startTime?: string;
  endTime?: string;
}

// ── Rule Definitions ──

const RULES: SarifRule[] = [
  {
    id: 'CB001',
    name: 'SecurityBlock',
    shortDescription: { text: 'A tool call was blocked for security reasons' },
    defaultConfiguration: { level: 'error' },
  },
  {
    id: 'CB002',
    name: 'PolicyBlock',
    shortDescription: { text: 'A tool call was blocked by policy configuration' },
    defaultConfiguration: { level: 'warning' },
  },
  {
    id: 'CB003',
    name: 'CapabilityBlock',
    shortDescription: { text: 'A tool call was blocked by capability restrictions' },
    defaultConfiguration: { level: 'warning' },
  },
  {
    id: 'CB004',
    name: 'ToolError',
    shortDescription: { text: 'A tool call resulted in an error' },
    defaultConfiguration: { level: 'note' },
  },
  {
    id: 'CB005',
    name: 'PermissionDenied',
    shortDescription: { text: 'A tool call was denied by the user' },
    defaultConfiguration: { level: 'note' },
  },
];

const ACTION_TO_RULE: Record<string, { ruleId: string; level: 'error' | 'warning' | 'note' }> = {
  security_block:   { ruleId: 'CB001', level: 'error' },
  policy_block:     { ruleId: 'CB002', level: 'warning' },
  capability_block: { ruleId: 'CB003', level: 'warning' },
  error:            { ruleId: 'CB004', level: 'note' },
  deny:             { ruleId: 'CB005', level: 'note' },
};

// ── Export Functions ──

/**
 * Convert audit entries to SARIF 2.1.0 log.
 * Only security-relevant entries (blocks, errors, denials) become results.
 */
export function exportSarif(entries: AuditEntry[], options?: SarifExportOptions): SarifLog {
  try {
    const version = options?.version || '1.9.0';
    const results: SarifResult[] = [];

    for (const entry of entries) {
      const mapping = ACTION_TO_RULE[entry.action];
      if (!mapping) continue; // Skip 'execute' — only security-relevant entries

      const result: SarifResult = {
        ruleId: mapping.ruleId,
        level: mapping.level,
        message: {
          text: buildMessage(entry),
        },
        properties: {
          timestamp: entry.timestamp,
          sessionId: entry.sessionId,
          sequence: entry.sequence,
          tool: entry.tool,
          action: entry.action,
        },
      };

      // Add file location if available
      const filePath = extractFilePath(entry);
      if (filePath) {
        result.locations = [{
          physicalLocation: {
            artifactLocation: { uri: filePath },
          },
        }];
      }

      results.push(result);
    }

    // Determine invocation times
    let startTime: string | undefined = options?.startTime;
    let endTime: string | undefined = options?.endTime;
    if (!startTime && entries.length > 0) {
      startTime = entries[0].timestamp;
    }
    if (!endTime && entries.length > 0) {
      endTime = entries[entries.length - 1].timestamp;
    }

    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'CodeBot',
            version,
            informationUri: 'https://github.com/zanderone1980/codebot-ai',
            rules: RULES,
          },
        },
        results,
        invocations: [{
          executionSuccessful: results.every(r => r.level !== 'error'),
          startTimeUtc: startTime,
          endTimeUtc: endTime,
          properties: options?.sessionId ? { sessionId: options.sessionId } : undefined,
        }],
      }],
    };
  } catch {
    // Fail-safe: return minimal valid SARIF
    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'CodeBot',
            version: options?.version || '1.9.0',
            informationUri: 'https://github.com/zanderone1980/codebot-ai',
            rules: RULES,
          },
        },
        results: [],
        invocations: [{ executionSuccessful: true }],
      }],
    };
  }
}

/** Serialize SARIF log to formatted JSON string */
export function sarifToString(log: SarifLog): string {
  return JSON.stringify(log, null, 2);
}

// ── Helpers ──

function buildMessage(entry: AuditEntry): string {
  const parts: string[] = [];
  parts.push(`Tool '${entry.tool}' — ${entry.action.replace(/_/g, ' ')}`);

  if (entry.reason) {
    parts.push(`: ${entry.reason}`);
  }

  return parts.join('');
}

function extractFilePath(entry: AuditEntry): string | undefined {
  const path = entry.args?.path;
  if (typeof path === 'string' && path.length > 0) {
    return path;
  }
  const file = entry.args?.file;
  if (typeof file === 'string' && file.length > 0) {
    return file;
  }
  return undefined;
}
