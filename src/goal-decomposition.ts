/**
 * Goal Decomposition Engine — breaks complex user requests into ordered subtasks.
 *
 * Uses pure heuristics (no LLM call) to detect complexity and split messages
 * into dependency-ordered subtasks the agent executes sequentially.
 *
 * Also provides a prompt builder for optional LLM-assisted decomposition
 * when the system prompt block wants richer breakdown.
 */

// ── Types ──

export interface SubTask {
  id: number;
  description: string;
  dependsOn: number[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface DecompositionResult {
  originalGoal: string;
  subtasks: SubTask[];
  estimatedTotalComplexity: 'low' | 'medium' | 'high';
}

// ── Constants ──

const ACTION_VERBS = [
  'add', 'create', 'fix', 'update', 'remove', 'implement', 'build',
  'refactor', 'test', 'deploy', 'configure', 'set up', 'write', 'move',
  'rename', 'delete', 'install', 'migrate', 'optimize', 'debug',
  'integrate', 'convert', 'extract', 'merge', 'split', 'enable',
  'disable', 'upgrade', 'downgrade', 'publish', 'document',
];

const TASK_CONJUNCTIONS = [
  ' and ', ' then ', ' also ', ' plus ', ' as well as ',
  ' after that ', ' next ', ' finally ', ' additionally ',
  ' followed by ', ' before ', ' once done ',
];

const HIGH_COMPLEXITY_KEYWORDS = [
  'refactor', 'implement', 'architect', 'redesign', 'migrate',
  'rewrite', 'overhaul', 'integrate', 'build',
];

const MEDIUM_COMPLEXITY_KEYWORDS = [
  'fix', 'update', 'modify', 'change', 'adjust', 'configure',
  'debug', 'optimize', 'test', 'convert',
];

const LOW_COMPLEXITY_KEYWORDS = [
  'rename', 'add', 'remove', 'delete', 'move', 'copy', 'install',
  'enable', 'disable', 'upgrade', 'publish', 'document',
];

// ── Helpers ──

function countActionVerbs(message: string): number {
  const lower = message.toLowerCase();
  let count = 0;
  for (const verb of ACTION_VERBS) {
    // Match verb at word boundary to avoid partial matches
    const pattern = new RegExp(`\\b${verb.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    const matches = lower.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function countTaskConjunctions(message: string): number {
  const lower = message.toLowerCase();
  let count = 0;
  for (const conj of TASK_CONJUNCTIONS) {
    let idx = lower.indexOf(conj);
    while (idx !== -1) {
      count++;
      idx = lower.indexOf(conj, idx + conj.length);
    }
  }
  return count;
}

function hasNumberedList(message: string): boolean {
  // Match "1. ", "1) ", "- ", "* " at start of lines
  return /(?:^|\n)\s*(?:\d+[.)]\s|[-*]\s)/m.test(message);
}

function countSentences(message: string): number {
  // Split on sentence-ending punctuation followed by space or end
  const sentences = message.split(/[.!?]+(?:\s|$)/).filter(s => s.trim().length > 0);
  return sentences.length;
}

function estimateComplexity(text: string): SubTask['estimatedComplexity'] {
  const lower = text.toLowerCase();
  for (const kw of HIGH_COMPLEXITY_KEYWORDS) {
    if (lower.includes(kw)) return 'high';
  }
  for (const kw of MEDIUM_COMPLEXITY_KEYWORDS) {
    if (lower.includes(kw)) return 'medium';
  }
  for (const kw of LOW_COMPLEXITY_KEYWORDS) {
    if (lower.includes(kw)) return 'low';
  }
  return 'medium'; // default
}

function overallComplexity(subtasks: SubTask[]): DecompositionResult['estimatedTotalComplexity'] {
  const complexities = subtasks.map(t => t.estimatedComplexity);
  if (complexities.includes('high')) return 'high';
  if (complexities.filter(c => c === 'medium').length >= 2) return 'high';
  if (complexities.includes('medium')) return 'medium';
  return 'low';
}

/**
 * Split a message into candidate task segments.
 * Handles numbered lists, bullet points, conjunction-separated clauses, and sentences.
 */
function splitIntoSegments(message: string): string[] {
  // 1. Try numbered/bulleted list items first
  const listPattern = /(?:^|\n)\s*(?:\d+[.)]\s|[-*]\s)(.+)/g;
  const listItems: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = listPattern.exec(message)) !== null) {
    listItems.push(match[1].trim());
  }
  if (listItems.length >= 2) return listItems;

  // 2. Split on task conjunctions
  let segments = [message];
  for (const conj of TASK_CONJUNCTIONS) {
    const newSegments: string[] = [];
    for (const seg of segments) {
      const parts = seg.toLowerCase().includes(conj.toLowerCase())
        ? splitOnConjunction(seg, conj)
        : [seg];
      newSegments.push(...parts);
    }
    segments = newSegments;
  }
  if (segments.length >= 2) {
    return segments.map(s => s.trim()).filter(s => s.length > 0);
  }

  // 3. Fall back to sentence splitting
  const sentences = message.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  if (sentences.length >= 2) return sentences.map(s => s.trim());

  // 4. Single segment
  return [message.trim()];
}

function splitOnConjunction(text: string, conjunction: string): string[] {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(conjunction.toLowerCase());
  if (idx === -1) return [text];

  const before = text.slice(0, idx).trim();
  const after = text.slice(idx + conjunction.length).trim();
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  if (after.length > 0) parts.push(after);
  return parts;
}

// ── Main Class ──

export class GoalDecomposer {
  /**
   * Heuristic check: returns true if the message is complex enough to
   * warrant decomposition (3+ signals detected).
   */
  shouldDecompose(message: string): boolean {
    let signals = 0;

    const verbCount = countActionVerbs(message);
    if (verbCount >= 3) signals++;
    if (verbCount >= 5) signals++; // extra signal for very verb-heavy messages

    const conjCount = countTaskConjunctions(message);
    if (conjCount >= 1) signals++;
    if (conjCount >= 3) signals++;

    if (hasNumberedList(message)) signals += 2; // lists are strong signal for multi-step

    if (message.length > 200 && countSentences(message) >= 2) signals++;

    // Multiple files/features mentioned
    const fileRefs = message.match(/\b[\w/-]+\.\w{1,5}\b/g);
    if (fileRefs && fileRefs.length >= 2) signals++;

    return signals >= 3;
  }

  /**
   * Break the message into ordered subtasks using local heuristics.
   * No LLM call required.
   */
  decompose(message: string, repoContext?: string): SubTask[] {
    const segments = splitIntoSegments(message);

    const subtasks: SubTask[] = segments.map((seg, idx) => ({
      id: idx + 1,
      description: seg.replace(/^(?:and|then|also|plus|finally|next|additionally)\s+/i, '').trim(),
      dependsOn: idx > 0 ? [idx] : [], // each task depends on the previous one
      estimatedComplexity: estimateComplexity(seg),
      status: 'pending' as const,
    }));

    // If repo context is provided, enrich descriptions
    if (repoContext && subtasks.length > 0) {
      subtasks[0].description = `${subtasks[0].description} (context: ${repoContext})`;
    }

    return subtasks;
  }

  /**
   * Build a prompt for LLM-assisted decomposition.
   * Used by the system prompt block when richer breakdown is desired.
   */
  buildDecompositionPrompt(message: string, repoContext?: string): string {
    const contextBlock = repoContext
      ? `\n\nRepository context:\n${repoContext}`
      : '';

    return `You are a goal decomposition engine. Break the following user request into ordered subtasks.

Rules:
- Each subtask should be a single, concrete action.
- Assign dependency IDs so tasks execute in the correct order.
- Estimate complexity: "low" (rename, add, remove), "medium" (fix, update, test), "high" (refactor, implement, migrate).
- Return valid JSON matching this schema:

\`\`\`typescript
interface SubTask {
  id: number;
  description: string;
  dependsOn: number[];  // IDs of prerequisite tasks
  estimatedComplexity: "low" | "medium" | "high";
}
\`\`\`

User request:
"${message}"${contextBlock}

Respond with a JSON array of SubTask objects. No other text.`;
  }

  /**
   * Build a full DecompositionResult from the message.
   */
  decomposeWithResult(message: string, repoContext?: string): DecompositionResult {
    const subtasks = this.decompose(message, repoContext);
    return {
      originalGoal: message,
      subtasks,
      estimatedTotalComplexity: overallComplexity(subtasks),
    };
  }
}
