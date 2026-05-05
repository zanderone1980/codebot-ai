/**
 * Stable serialization for tool-call dedup keys. Sorts object keys so
 * { a: 1, b: 2 } and { b: 2, a: 1 } produce the same string.
 */
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableSerialize(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Composes the dedup key for a single tool execution. */
export function buildToolExecutionSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${stableSerialize(args)}`;
}
