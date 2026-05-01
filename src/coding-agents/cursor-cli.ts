/**
 * CursorCliAgentProvider — PR 28 of personal-agent-infrastructure.md.
 *
 * Wraps Cursor's open-source headless CLI (`agent --print --output-format
 * stream-json`). Zero npm deps — the CLI is invoked as a subprocess and
 * its stream-json line protocol is parsed into our TaskEvent union.
 *
 * Auth: `CURSOR_API_KEY` env var, sourced from the vault key `cursor` by
 * CodingAgentRegistry. Providers don't read the vault directly.
 *
 * Budget: token counts from the CLI's terminal `result` event are checked
 * against PermissionProfile.budget.tokens. We can't pre-empt mid-run on
 * cost (the CLI doesn't expose a hard cap flag) — instead we surface an
 * over-budget result as ok:false on the TaskEvent so callers can refuse
 * to chain a follow-up.
 *
 * The binary path is overridable for tests via `cursorBinary` ctor arg —
 * tests inject a fake Node script that prints fixture stream-json and
 * exits, so we exercise the parser without spending real Cursor credits.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { AuditLogger } from '../audit';
import { appendEvent } from './state';
import type { CapabilityLabel } from '../types';
import type {
  CodingAgentProvider,
  TaskSpec,
  TaskHandle,
  TaskEvent,
  TaskStatus,
} from './types';

export interface CursorCliOptions {
  /** Override the binary name/path. Defaults to `agent` on PATH. */
  cursorBinary?: string;
  /** Override model id. Defaults to whatever the CLI picks. */
  model?: string;
  /** Optional injection point for tests. */
  audit?: AuditLogger;
}

/** Shape of one line from `agent --output-format stream-json`. */
interface CursorStreamLine {
  type: 'system' | 'assistant' | 'tool_call' | 'result' | string;
  timestamp_ms?: number;
  // assistant
  text?: string;
  // tool_call
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  // result
  summary?: string;
  tokens?: number;
  // catch-all
  [key: string]: unknown;
}

class CursorCliTaskHandle implements TaskHandle {
  readonly id: string;
  readonly spec: Readonly<TaskSpec>;
  private currentStatus: TaskStatus = 'queued';
  private buffer: TaskEvent[] = [];
  private resolveNext: ((e: IteratorResult<TaskEvent>) => void) | null = null;
  private done = false;
  private child: ChildProcess | null = null;
  private audit: AuditLogger | null;
  private stdoutCarry = '';
  private exitTokens = 0;
  private resultEmitted = false;

  constructor(
    spec: TaskSpec,
    audit: AuditLogger | null,
    binary: string,
    model: string | undefined,
    apiKey: string,
  ) {
    this.id = spec.id!;
    this.spec = Object.freeze({ ...spec });
    this.audit = audit;

    const args = [
      '--print',
      '--force',
      '--approve-mcps',
      '--output-format',
      'stream-json',
      '--workspace',
      spec.cwd,
    ];
    if (model) {
      args.push('--model', model);
    }
    args.push(spec.prompt);

    setImmediate(() => this.run(binary, args, apiKey));
  }

  private now(): string {
    return new Date().toISOString();
  }

  private emit(event: TaskEvent, statusUpdate?: TaskStatus): void {
    if (statusUpdate) this.currentStatus = statusUpdate;
    appendEvent(this.id, event, statusUpdate);
    const action: 'task_event' | 'task_complete' | 'task_cancelled' =
      event.type === 'result'
        ? 'task_complete'
        : statusUpdate === 'cancelled'
        ? 'task_cancelled'
        : 'task_event';
    this.audit?.log({
      tool: 'coding-agent:cursor-cli',
      action,
      args: { id: this.id, event },
    });
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  private finish(): void {
    this.done = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as unknown as TaskEvent, done: true });
    }
  }

  /**
   * Parse one stream-json line into a TaskEvent. Returns null when the
   * line shouldn't surface (e.g. internal `system` rows we don't expose).
   */
  private parseLine(line: CursorStreamLine): TaskEvent | null {
    const at = this.now();
    switch (line.type) {
      case 'assistant': {
        const text = typeof line.text === 'string' ? line.text : '';
        if (!text) return null;
        return { type: 'output', channel: 'stdout', text, at };
      }
      case 'tool_call': {
        const tool = typeof line.tool === 'string' ? line.tool : 'unknown';
        // file-write tools surface as file_change; everything else as command.
        if (tool === 'edit_file' || tool === 'write_file' || tool === 'create_file') {
          const p =
            typeof line.args === 'object' && line.args !== null && typeof (line.args as Record<string, unknown>).path === 'string'
              ? ((line.args as Record<string, unknown>).path as string)
              : '<unknown>';
          const op: 'create' | 'modify' | 'delete' =
            tool === 'create_file' ? 'create' : tool === 'write_file' ? 'modify' : 'modify';
          return { type: 'file_change', path: p, op, at };
        }
        if (tool === 'delete_file') {
          const p =
            typeof line.args === 'object' && line.args !== null && typeof (line.args as Record<string, unknown>).path === 'string'
              ? ((line.args as Record<string, unknown>).path as string)
              : '<unknown>';
          return { type: 'file_change', path: p, op: 'delete', at };
        }
        const cmd =
          typeof line.args === 'object' && line.args !== null && typeof (line.args as Record<string, unknown>).command === 'string'
            ? ((line.args as Record<string, unknown>).command as string)
            : tool;
        return { type: 'command', command: cmd, exitCode: line.ok === false ? 1 : 0, at };
      }
      case 'result': {
        const ok = line.ok !== false;
        const summary = typeof line.summary === 'string' ? line.summary : '';
        if (typeof line.tokens === 'number') this.exitTokens = line.tokens;
        const cap = this.spec.permissions.budget?.tokens;
        const overBudget = typeof cap === 'number' && this.exitTokens > cap;
        this.resultEmitted = true;
        return {
          type: 'result',
          ok: ok && !overBudget,
          summary: overBudget
            ? `${summary} [BUDGET EXCEEDED: ${this.exitTokens} > ${cap} tokens]`
            : summary,
          at,
        };
      }
      case 'system':
      default:
        return null;
    }
  }

  private handleStdoutChunk(buf: Buffer): void {
    this.stdoutCarry += buf.toString('utf-8');
    let nl: number;
    while ((nl = this.stdoutCarry.indexOf('\n')) !== -1) {
      const raw = this.stdoutCarry.slice(0, nl).trim();
      this.stdoutCarry = this.stdoutCarry.slice(nl + 1);
      if (!raw) continue;
      let parsed: CursorStreamLine;
      try {
        parsed = JSON.parse(raw) as CursorStreamLine;
      } catch (err) {
        this.emit({
          type: 'log',
          level: 'warn',
          message: `cursor-cli: unparseable stream-json line: ${(err as Error).message}`,
          at: this.now(),
        });
        continue;
      }
      const ev = this.parseLine(parsed);
      if (ev) {
        const status: TaskStatus | undefined =
          ev.type === 'result' ? (ev.ok ? 'succeeded' : 'failed') : undefined;
        this.emit(ev, status);
      }
    }
  }

  private run(binary: string, args: string[], apiKey: string): void {
    if (this.done) return;
    this.emit({ type: 'status', status: 'running', at: this.now() }, 'running');

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: this.spec.cwd,
        env: { ...process.env, CURSOR_API_KEY: apiKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit(
        {
          type: 'result',
          ok: false,
          summary: `cursor-cli spawn failed: ${(err as Error).message}`,
          at: this.now(),
        },
        'failed',
      );
      this.finish();
      return;
    }
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      if (text.trim()) {
        this.emit({ type: 'output', channel: 'stderr', text, at: this.now() });
      }
    });

    child.on('error', err => {
      this.emit(
        {
          type: 'result',
          ok: false,
          summary: `cursor-cli error: ${err.message}`,
          at: this.now(),
        },
        'failed',
      );
      this.finish();
    });

    child.on('close', code => {
      // If the CLI exited without ever emitting a `result` row (crash, killed,
      // signal), synthesize one so callers always see a terminal event.
      if (!this.resultEmitted && this.currentStatus !== 'cancelled') {
        const ok = code === 0;
        this.emit(
          {
            type: 'result',
            ok,
            summary: ok
              ? 'cursor-cli exited 0 without result row'
              : `cursor-cli exited ${code} without result row`,
            at: this.now(),
          },
          ok ? 'succeeded' : 'failed',
        );
      }
      this.finish();
    });
  }

  status(): TaskStatus {
    return this.currentStatus;
  }

  events(): AsyncIterable<TaskEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
        return {
          next(): Promise<IteratorResult<TaskEvent>> {
            if (self.buffer.length > 0) {
              const event = self.buffer.shift()!;
              return Promise.resolve({ value: event, done: false });
            }
            if (self.done) {
              return Promise.resolve({ value: undefined as unknown as TaskEvent, done: true });
            }
            return new Promise<IteratorResult<TaskEvent>>(res => {
              self.resolveNext = res;
            });
          },
        };
      },
    };
  }

  async cancel(reason: string): Promise<void> {
    if (
      this.currentStatus === 'succeeded' ||
      this.currentStatus === 'failed' ||
      this.currentStatus === 'cancelled'
    ) {
      return;
    }
    this.emit(
      { type: 'log', level: 'warn', message: `cancelled: ${reason}`, at: this.now() },
      'cancelled',
    );
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // Best effort.
      }
    }
    this.audit?.log({
      tool: 'coding-agent:cursor-cli',
      action: 'task_cancelled',
      args: { id: this.id, reason },
    });
    this.finish();
  }

  async respondToApproval(): Promise<void> {
    // The headless CLI runs with --force and does not request approvals.
    // PR 28b (when we wrap @cursor/sdk) will need this for hooks.
    throw new Error('cursor-cli runs headless with --force; no approval prompts');
  }
}

export class CursorCliAgentProvider implements CodingAgentProvider {
  readonly name = 'cursor-cli';
  readonly displayName = 'Cursor CLI (headless agent)';
  readonly capabilities: CapabilityLabel[] = [
    'read-only',
    'write-fs',
    'run-cmd',
    'net-fetch',
    'account-access',
  ];
  readonly vaultKeyName = 'cursor';

  private binary: string;
  private model: string | undefined;
  private audit: AuditLogger | null;

  constructor(opts: CursorCliOptions = {}) {
    this.binary = opts.cursorBinary || 'cursor-agent';
    this.model = opts.model;
    this.audit = opts.audit ?? null;
  }

  validateSpec(spec: TaskSpec): string | null {
    if (!spec.title || spec.title.trim().length === 0) return 'title is required';
    if (!spec.prompt || spec.prompt.trim().length === 0) return 'prompt is required';
    if (!spec.cwd || spec.cwd.trim().length === 0) return 'cwd is required';
    try {
      const stat = fs.statSync(spec.cwd);
      if (!stat.isDirectory()) return `cwd is not a directory: ${spec.cwd}`;
    } catch {
      return `cwd does not exist: ${spec.cwd}`;
    }
    return null;
  }

  async start(spec: TaskSpec, credential: string | null): Promise<TaskHandle> {
    if (!credential) {
      throw new Error(
        'cursor-cli requires a CURSOR_API_KEY — store via `codebot vault set cursor <key>`',
      );
    }
    return new CursorCliTaskHandle(spec, this.audit, this.binary, this.model, credential);
  }
}
