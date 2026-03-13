/**
 * CodeBot AI — Intent Classifier
 *
 * Lightweight regex/keyword intent classification for natural language input.
 * Runs synchronously — no LLM call needed. Used to adapt system prompt persona
 * and suggest workflows.
 */

export type IntentCategory =
  | 'social_media'
  | 'research'
  | 'email'
  | 'scheduling'
  | 'automation'
  | 'coding'
  | 'creative'
  | 'system'
  | 'general';

export interface ParsedIntent {
  category: IntentCategory;
  confidence: number;
  suggestedWorkflow?: string;
  extractedParams: Record<string, string>;
}

interface IntentPattern {
  category: IntentCategory;
  patterns: RegExp[];
  workflow?: string;
  paramExtractors?: Record<string, RegExp>;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    category: 'social_media',
    patterns: [
      /\b(post|tweet|share|publish)\b.*\b(x|twitter|social|facebook|instagram|linkedin|threads)\b/i,
      /\b(x|twitter|social media)\b.*\b(post|tweet|thread|share|publish|schedule)\b/i,
      /\bschedule.*\b(post|tweet|thread)\b/i,
      /\b(tweet|retweet|reply|quote\s?tweet)\b/i,
    ],
    workflow: 'post-on-x',
    paramExtractors: {
      platform: /\b(x|twitter|facebook|instagram|linkedin|threads)\b/i,
      content: /(?:about|saying|with|:)\s+"?([^"]+)"?$/i,
    },
  },
  {
    category: 'research',
    patterns: [
      /\b(research|find out|look up|investigate|summarize|what is|what are|who is|tell me about)\b/i,
      /\b(search|google|look for|find information)\b/i,
      /\blatest\b.*\b(news|updates|trends|developments)\b/i,
    ],
    workflow: 'research-topic',
    paramExtractors: {
      topic: /(?:about|on|for|into)\s+(.+)/i,
    },
  },
  {
    category: 'email',
    patterns: [
      /\b(send|write|compose|draft|reply|forward)\b.*\b(email|mail|message)\b/i,
      /\b(email|mail|gmail|outlook)\b.*\b(send|check|read|open|compose)\b/i,
      /\bcheck\s+(?:my\s+)?(?:inbox|email|mail)\b/i,
    ],
    workflow: 'send-email',
    paramExtractors: {
      to: /\bto\s+([^\s,]+@[^\s,]+)/i,
      subject: /\b(?:about|subject|re:?)\s+"?([^"]+)"?/i,
    },
  },
  {
    category: 'scheduling',
    patterns: [
      /\b(remind|reminder|schedule|alarm|timer|every day|every morning|every week|daily|weekly)\b/i,
      /\b(at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b.*\b(do|run|check|post|send)\b/i,
      /\b(remind me|set a reminder|don't forget|remember to)\b/i,
    ],
    workflow: 'set-reminder',
    paramExtractors: {
      time: /\b(?:at|every)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
    },
  },
  {
    category: 'automation',
    patterns: [
      /\b(automate|whenever|watch for|monitor|trigger|if.*then)\b/i,
      /\b(set up|create).*\b(routine|automation|workflow|pipeline)\b/i,
    ],
  },
  {
    category: 'coding',
    patterns: [
      /\b(code|program|function|class|module|bug|error|debug|refactor|test|deploy|compile|build)\b/i,
      /\b(git|npm|pip|docker|ssh|api|endpoint|database|sql|query)\b/i,
      /\b(typescript|javascript|python|rust|go|java|html|css|react|node)\b/i,
      /\b(fix|implement|create|write).*\b(code|feature|component|service)\b/i,
    ],
  },
  {
    category: 'creative',
    patterns: [
      /\b(write|draft|create|generate)\b.*\b(blog|article|post|story|content|copy|message|letter)\b/i,
      /\b(rewrite|edit|proofread|improve)\b.*\b(text|writing|draft|content)\b/i,
      /\b(generate|create|design|make)\b.*\b(image|logo|graphic|banner|thumbnail)\b/i,
    ],
  },
  {
    category: 'system',
    patterns: [
      /\b(check|show|how much)\b.*\b(disk|space|ram|memory|cpu|storage|battery|uptime)\b/i,
      /\b(system|computer|machine|server)\b.*\b(info|status|health|specs)\b/i,
      /\b(install|update|uninstall|restart|shutdown|kill|process)\b/i,
    ],
  },
];

/**
 * Classify user message intent using pattern matching.
 * Returns the best-matching category with confidence score.
 */
export function classifyIntent(message: string): ParsedIntent {
  const trimmed = message.trim();
  if (!trimmed) {
    return { category: 'general', confidence: 0, extractedParams: {} };
  }

  let bestMatch: ParsedIntent = { category: 'general', confidence: 0.1, extractedParams: {} };
  let bestScore = 0;

  for (const intent of INTENT_PATTERNS) {
    let matchCount = 0;
    for (const pattern of intent.patterns) {
      if (pattern.test(trimmed)) matchCount++;
    }

    if (matchCount === 0) continue;

    // Score: ratio of matched patterns (more matches = higher confidence)
    const score = matchCount / intent.patterns.length;
    const confidence = Math.min(0.95, 0.3 + score * 0.6);

    if (confidence > bestScore) {
      bestScore = confidence;

      // Extract params if available
      const params: Record<string, string> = {};
      if (intent.paramExtractors) {
        for (const [key, extractor] of Object.entries(intent.paramExtractors)) {
          const match = trimmed.match(extractor);
          if (match?.[1]) params[key] = match[1].trim();
        }
      }

      bestMatch = {
        category: intent.category,
        confidence,
        suggestedWorkflow: intent.workflow,
        extractedParams: params,
      };
    }
  }

  return bestMatch;
}

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
