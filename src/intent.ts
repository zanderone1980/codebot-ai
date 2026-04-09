/**
 * CodeBot AI — Intent Helpers
 *
 * Lightweight helpers for adapting system prompt persona.
 */

/**
 * Detect if a user appears to be technical based on their messages.
 * Used to adapt the system prompt persona.
 */
export function isLikelyDeveloper(messages: Array<{ role: string; content: string | unknown }>): boolean {
  const devPatterns = /\b(git|npm|pip|docker|ssh|api|endpoint|deploy|compile|build|debug|refactor|function|class|module|import|export|const|let|var|async|await|promise|callback|interface|type|struct|enum)\b/i;

  let devSignals = 0;
  let totalUserMessages = 0;

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    totalUserMessages++;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (devPatterns.test(content)) devSignals++;
  }

  if (totalUserMessages === 0) return false;
  return devSignals / totalUserMessages > 0.3;
}
