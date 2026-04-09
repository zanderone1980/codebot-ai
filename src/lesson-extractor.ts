/**
 * Lesson Extractor — Converts tool execution outcomes into experiential lessons.
 *
 * Pattern-based extraction (no LLM calls) to avoid self-evaluation bias.
 * Covers the most common CodeBot tool errors and success patterns.
 */

import { Lesson } from './experiential-memory';
import * as crypto from 'crypto';

/** Known error patterns and their lesson templates */
const FAILURE_PATTERNS: Array<{
  pattern: RegExp;
  lesson: (match: RegExpMatchArray, tool: string, args: Record<string, unknown>) => Partial<Lesson>;
}> = [
  {
    pattern: /ENOENT.*no such file or directory.*'([^']+)'/i,
    lesson: (m, tool) => ({
      lesson: `File "${m[1]}" does not exist. Verify the path before attempting to ${tool}.`,
      avoidance: `Do not assume file exists without checking first.`,
      tags: 'enoent,file-not-found,path',
    }),
  },
  {
    pattern: /EACCES.*permission denied.*'([^']+)'/i,
    lesson: (m, tool) => ({
      lesson: `Permission denied for "${m[1]}". Check file permissions or run with appropriate access.`,
      avoidance: `Do not attempt to write to restricted paths.`,
      tags: 'eacces,permission,access',
    }),
  },
  {
    pattern: /SyntaxError.*([^:]+):(\d+):(\d+)/i,
    lesson: (m, tool) => ({
      lesson: `Syntax error in ${m[1]} at line ${m[2]}. Validate syntax before saving.`,
      avoidance: `Check for matching brackets, missing semicolons, or invalid syntax.`,
      tags: 'syntax,parse-error',
    }),
  },
  {
    pattern: /timeout|timed out|ETIMEDOUT/i,
    lesson: (_m, tool, args) => ({
      lesson: `${tool} timed out. Consider increasing timeout or breaking the operation into smaller steps.`,
      avoidance: `Set timeout to at least 120000ms for long-running commands.`,
      tags: 'timeout,slow,performance',
    }),
  },
  {
    pattern: /npm ERR!.*missing script.*"([^"]+)"/i,
    lesson: (m) => ({
      lesson: `npm script "${m[1]}" does not exist. Check package.json scripts before running.`,
      avoidance: `Read package.json to verify available scripts first.`,
      tags: 'npm,script,missing',
    }),
  },
  {
    pattern: /npm ERR!|yarn error|pnpm ERR/i,
    lesson: (_m, _tool, args) => ({
      lesson: `Package manager command failed. Check lockfile, node version, and dependencies.`,
      avoidance: `Verify the package manager and lockfile type before running install commands.`,
      tags: 'npm,yarn,pnpm,install,dependencies',
    }),
  },
  {
    pattern: /FAIL|FAILED|test.*fail/i,
    lesson: (_m, _tool, args) => ({
      lesson: `Tests failed. Read the failure output carefully before making more changes.`,
      avoidance: `Do not make additional changes without understanding why tests failed.`,
      tags: 'test,failure,regression',
    }),
  },
  {
    pattern: /CONFLICT|merge conflict|<<<<<<</,
    lesson: () => ({
      lesson: `Git merge conflict detected. Resolve conflicts manually — do not force push.`,
      avoidance: `Pull and resolve before committing.`,
      tags: 'git,merge,conflict',
    }),
  },
  {
    pattern: /error TS\d+:/i,
    lesson: (_m, _tool, args) => ({
      lesson: `TypeScript compilation error. Check type definitions, imports, and interfaces.`,
      avoidance: `Run tsc --noEmit to check types before committing.`,
      tags: 'typescript,compile,types',
    }),
  },
  {
    pattern: /ModuleNotFoundError|Cannot find module.*'([^']+)'/i,
    lesson: (m) => ({
      lesson: `Module "${m[1] || 'unknown'}" not found. Check import paths and installed dependencies.`,
      avoidance: `Verify the module is installed and the import path is correct.`,
      tags: 'import,module,not-found',
    }),
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i,
    lesson: () => ({
      lesson: `Network connection failed. Check if the service is running and the URL is correct.`,
      avoidance: `Verify the service is accessible before making requests.`,
      tags: 'network,connection,refused',
    }),
  },
  {
    pattern: /rate limit|429|too many requests/i,
    lesson: () => ({
      lesson: `Rate limited. Add delays between requests or reduce request volume.`,
      avoidance: `Implement backoff or batch requests to avoid rate limits.`,
      tags: 'rate-limit,429,throttle',
    }),
  },
  {
    pattern: /out of memory|heap|ENOMEM/i,
    lesson: () => ({
      lesson: `Out of memory. Break the operation into smaller chunks or increase memory limits.`,
      avoidance: `Process large datasets in batches, not all at once.`,
      tags: 'memory,heap,oom',
    }),
  },
  {
    pattern: /command not found|is not recognized/i,
    lesson: (_m, _tool, args) => {
      const cmd = typeof args.command === 'string' ? args.command.split(' ')[0] : 'unknown';
      return {
        lesson: `Command "${cmd}" not found. Check if it is installed and in PATH.`,
        avoidance: `Verify the command exists before running it.`,
        tags: 'command,not-found,path',
      };
    },
  },
];

/** Tools where success is trivial and not worth recording */
const TRIVIAL_SUCCESS_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'think', 'memory', 'code_analysis',
  'multi_search', 'diff_viewer', 'image_info', 'web_search', 'web_fetch',
]);

/**
 * Extract a lesson from a failed tool execution.
 * Always produces a lesson — failures are always worth recording.
 */
export function extractLessonFromFailure(
  toolName: string,
  args: Record<string, unknown>,
  errorMessage: string,
  taskContext: string,
): Partial<Lesson> & Pick<Lesson, 'toolName' | 'outcome' | 'lesson'> {
  // Try pattern matching first
  for (const { pattern, lesson } of FAILURE_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) {
      const extracted = lesson(match, toolName, args);
      return {
        id: crypto.randomUUID(),
        toolName,
        outcome: 'failure',
        errorMessage: errorMessage.substring(0, 500),
        taskDescription: taskContext.substring(0, 200),
        approach: summarizeArgs(toolName, args),
        confidence: 0.6,
        ...extracted,
        lesson: extracted.lesson || `${toolName} failed: ${errorMessage.substring(0, 100)}`,
      };
    }
  }

  // Generic fallback — still record it
  return {
    id: crypto.randomUUID(),
    toolName,
    outcome: 'failure',
    lesson: `${toolName} failed with: ${errorMessage.substring(0, 150)}. Review the error before retrying.`,
    avoidance: `Check the specific error condition before attempting this operation again.`,
    errorMessage: errorMessage.substring(0, 500),
    taskDescription: taskContext.substring(0, 200),
    approach: summarizeArgs(toolName, args),
    tags: `${toolName},error`,
    confidence: 0.5,
  };
}

/**
 * Extract a lesson from a successful tool execution.
 * Selective — only records non-trivial successes.
 */
export function extractLessonFromSuccess(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  taskContext: string,
): (Partial<Lesson> & Pick<Lesson, 'toolName' | 'outcome' | 'lesson'>) | null {
  if (!shouldRecordSuccess(toolName, args, output)) return null;

  const approach = summarizeArgs(toolName, args);
  return {
    id: crypto.randomUUID(),
    toolName,
    outcome: 'success',
    lesson: `${toolName} succeeded: ${approach}`,
    taskDescription: taskContext.substring(0, 200),
    approach,
    tags: buildTags(toolName, args, ''),
    confidence: 0.4, // Lower confidence for successes — needs reinforcement
  };
}

/**
 * Determine if a success is worth recording.
 * Skip trivial read-only operations. Record writes, executions, and complex operations.
 */
export function shouldRecordSuccess(toolName: string, args: Record<string, unknown>, output: string): boolean {
  // Trivial tools — never record
  if (TRIVIAL_SUCCESS_TOOLS.has(toolName)) return false;

  // Write operations — record
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') return true;

  // Execute commands that ran tests or builds — record
  if (toolName === 'execute') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (/test|build|compile|lint|deploy/i.test(cmd)) return true;
  }

  // Git operations — record
  if (toolName === 'git') return true;

  // Browser actions — record
  if (toolName === 'browser') return true;

  // Docker operations — record
  if (toolName === 'docker') return true;

  return false;
}

/**
 * Build keyword tags from tool execution context.
 */
export function buildTags(toolName: string, args: Record<string, unknown>, errorMessage: string): string {
  const tags: Set<string> = new Set([toolName]);

  // Extract file extension
  const filePath = (args.path || args.file || '') as string;
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext && ext.length <= 5) tags.add(ext);
    // Add directory context
    const dir = filePath.split('/').slice(-2, -1)[0];
    if (dir) tags.add(dir);
  }

  // Extract command name
  if (typeof args.command === 'string') {
    const cmd = args.command.split(' ')[0].split('/').pop();
    if (cmd) tags.add(cmd);
  }

  // Extract error keywords
  if (errorMessage) {
    const keywords = errorMessage.match(/\b(ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|SyntaxError|TypeError|ReferenceError|npm|git|docker|test|build|compile)\b/gi);
    if (keywords) keywords.forEach(k => tags.add(k.toLowerCase()));
  }

  return Array.from(tags).join(',');
}

/**
 * Summarize tool args into a human-readable approach description.
 */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
    case 'read_file':
    case 'edit_file':
      return `${toolName} on ${args.path || 'unknown'}`;
    case 'execute':
      return `execute: ${(args.command as string || '').substring(0, 100)}`;
    case 'git':
      return `git ${args.action || args.command || 'unknown'}`;
    case 'browser':
      return `browser ${args.action || 'unknown'}${args.url ? ': ' + (args.url as string).substring(0, 50) : ''}`;
    case 'grep':
      return `grep "${args.pattern || ''}" in ${args.path || '.'}`;
    case 'glob':
      return `glob ${args.pattern || ''}`;
    default:
      return `${toolName}(${Object.keys(args).join(', ')})`;
  }
}
