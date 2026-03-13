/**
 * Session Replay Engine for CodeBot v1.8.0
 *
 * Replays saved sessions by feeding recorded assistant responses
 * instead of calling the LLM. Tool calls are re-executed and outputs
 * compared against recorded results to detect environment divergences.
 *
 * Usage:
 *   codebot --replay <session-id>
 *   codebot --replay              (replays latest session)
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';
import { Message, ToolCall, LLMProvider, ToolSchema, StreamEvent } from './types';

// ── Replay Provider ──

/**
 * Mock LLM provider that feeds recorded assistant messages.
 * Used during replay to bypass actual LLM calls.
 */
export class ReplayProvider implements LLMProvider {
  name = 'replay';
  private assistantMessages: Message[];
  private callIndex: number = 0;

  constructor(assistantMessages: Message[]) {
    this.assistantMessages = assistantMessages;
  }

  async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    const msg = this.assistantMessages[this.callIndex++];
    if (!msg) {
      yield { type: 'text', text: '[replay: no more recorded responses]' };
      yield { type: 'done' };
      return;
    }

    // Emit text content
    if (msg.content) {
      yield { type: 'text', text: msg.content };
    }

    // Emit tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        yield {
          type: 'tool_call_end',
          toolCall: tc,
        };
      }
    }

    yield { type: 'done' };
  }
}

// ── Session Loading ──

export interface SessionReplayData {
  messages: Message[];
  assistantMessages: Message[];
  userMessages: Message[];
  toolResults: Map<string, string>;  // tool_call_id → recorded output
}

/**
 * Load a session from disk and prepare it for replay.
 * Returns null if session doesn't exist or is empty.
 */
export function loadSessionForReplay(sessionId: string): SessionReplayData | null {
  const sessionsDir = codebotPath('sessions');
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }

  if (!content) return null;

  const messages: Message[] = [];
  for (const line of content.split('\n')) {
    try {
      const obj = JSON.parse(line);
      delete obj._ts;
      delete obj._model;
      delete obj._sig;
      messages.push(obj as Message);
    } catch { continue; }
  }

  if (messages.length === 0) return null;

  const assistantMessages = messages.filter(m => m.role === 'assistant');
  const userMessages = messages.filter(m => m.role === 'user');
  const toolResults = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, msg.content);
    }
  }

  return { messages, assistantMessages, userMessages, toolResults };
}

// ── Output Comparison ──

export interface ReplayDivergence {
  toolCallId: string;
  toolName: string;
  type: 'output_mismatch';
  diff: string;
}

/**
 * Compare recorded vs actual tool output.
 * Returns null if identical, or a diff description.
 */
export function compareOutputs(recorded: string, actual: string): string | null {
  if (recorded === actual) return null;

  // Normalize whitespace for soft comparison
  const normRecorded = recorded.trim().replace(/\s+/g, ' ');
  const normActual = actual.trim().replace(/\s+/g, ' ');
  if (normRecorded === normActual) return null;

  const maxShow = 200;
  const expectedSnippet = normRecorded.length > maxShow
    ? normRecorded.substring(0, maxShow) + '...'
    : normRecorded;
  const actualSnippet = normActual.length > maxShow
    ? normActual.substring(0, maxShow) + '...'
    : normActual;

  return `Expected: ${expectedSnippet}\nActual:   ${actualSnippet}`;
}

// ── Session Listing ──

/**
 * List sessions available for replay.
 */
export function listReplayableSessions(limit: number = 10): Array<{
  id: string;
  preview: string;
  messageCount: number;
  date: string;
}> {
  const sessionsDir = codebotPath('sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const stat = fs.statSync(path.join(sessionsDir, f));
      return { name: f, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit);

  return files.map(f => {
    const id = f.name.replace('.jsonl', '');
    const fullPath = path.join(sessionsDir, f.name);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      const lines = content ? content.split('\n') : [];
      let preview = '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.role === 'user') {
            preview = msg.content.substring(0, 80);
            break;
          }
        } catch { continue; }
      }
      return { id, preview, messageCount: lines.length, date: f.mtime.toISOString() };
    } catch {
      return { id, preview: '', messageCount: 0, date: f.mtime.toISOString() };
    }
  });
}
