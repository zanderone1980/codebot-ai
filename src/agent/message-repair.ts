/**
 * Message validation, repair, and sanitization helpers for the Agent.
 * Extracted from agent.ts for maintainability.
 */

import { Message } from '../types';

/** Max tool output size before truncation (50KB) */
const MAX_TOOL_OUTPUT = 50 * 1024;
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Sanitize tool output: strip ANSI codes, truncate if too large */
export function sanitizeToolOutput(output: string): string {
  let clean = output.replace(ANSI_REGEX, '');
  if (clean.length > MAX_TOOL_OUTPUT) {
    const kept = clean.substring(0, MAX_TOOL_OUTPUT);
    const dropped = clean.length - MAX_TOOL_OUTPUT;
    clean = `${kept}\n\n... [output truncated: ${dropped} characters omitted. Total was ${clean.length} chars]`;
  }
  return clean;
}

/** Lightweight schema validation — returns error string or null if valid */
export function validateToolArgs(args: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = schema.required as string[] | undefined;

  if (!props) return null;

  // Check required fields exist
  if (required) {
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        return `missing required field '${field}'`;
      }
    }
  }

  // Check types match for provided fields
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema) continue;

    const expectedType = propSchema.type as string | undefined;
    if (!expectedType) continue;

    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (expectedType === 'integer' || expectedType === 'number') {
      if (typeof value !== 'number') {
        return `field '${key}' expected ${expectedType}, got ${actualType}`;
      }
    } else if (actualType !== expectedType) {
      return `field '${key}' expected ${expectedType}, got ${actualType}`;
    }
  }

  return null;
}

/**
 * Validate and repair message history to prevent OpenAI 400 errors.
 * Handles three types of corruption:
 *  1. Orphaned tool messages — tool_call_id doesn't match any preceding assistant's tool_calls
 *  2. Duplicate tool responses — multiple tool messages for the same tool_call_id
 *  3. Missing tool responses — assistant has tool_calls but no matching tool response
 */
export function repairToolCallMessages(messages: Message[]): Message[] {
  // Phase 1: Collect all valid tool_call_ids from assistant messages
  const validToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        validToolCallIds.add(tc.id);
      }
    }
  }

  // Phase 2: Remove orphaned tool messages and duplicates
  const seenToolResponseIds = new Set<string>();
  const filtered = messages.filter(msg => {
    if (msg.role !== 'tool') return true;
    const tcId = msg.tool_call_id;
    if (!tcId) return false;
    if (!validToolCallIds.has(tcId)) return false;
    if (seenToolResponseIds.has(tcId)) return false;
    seenToolResponseIds.add(tcId);
    return true;
  });

  // Phase 3: Add missing tool responses
  const toolResponseIds = new Set<string>();
  for (const msg of filtered) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResponseIds.add(msg.tool_call_id);
    }
  }

  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (!toolResponseIds.has(tc.id)) {
          const repairMsg: Message = {
            role: 'tool',
            content: 'Error: tool call was not executed (interrupted).',
            tool_call_id: tc.id,
          };
          let insertAt = i + 1;
          while (insertAt < filtered.length && filtered[insertAt].role === 'tool') {
            insertAt++;
          }
          filtered.splice(insertAt, 0, repairMsg);
          toolResponseIds.add(tc.id);
        }
      }
    }
  }

  return filtered;
}
