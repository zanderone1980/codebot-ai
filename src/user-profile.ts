/**
 * User Profile System — Persistent user preferences and learned patterns.
 *
 * Stores preferences (writing style, timezone, platforms), learned patterns
 * (common topics, corrections, style examples), and connected services.
 * Injected into the system prompt for personalized behavior.
 *
 * Stored at ~/.codebot/profile.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';



export interface UserPreferences {
  name?: string;
  timezone?: string;
  writingStyle?: 'formal' | 'casual' | 'professional' | 'friendly';
  verbosity?: 'concise' | 'normal' | 'detailed';
  platforms?: string[];   // e.g. ['twitter', 'github', 'gmail']
  interests?: string[];   // topics the user cares about
  language?: string;      // preferred language for responses
}

export interface LearnedPattern {
  type: 'correction' | 'preference' | 'topic' | 'style';
  content: string;
  learnedAt: string;
}

export interface UserProfileData {
  preferences: UserPreferences;
  patterns: LearnedPattern[];
  commonActions: Record<string, number>;  // action -> frequency count
  connectedServices: string[];
  createdAt: string;
  updatedAt: string;
}

function defaultProfile(): UserProfileData {
  return {
    preferences: {},
    patterns: [],
    commonActions: {},
    connectedServices: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * User Profile manager — load, save, learn from interactions.
 */
export class UserProfile {
  private data: UserProfileData;
  private dirty = false;
  private lastSaveTime = 0;

  constructor() {
    this.data = this.load();
  }

  /** Load profile from disk */
  private load(): UserProfileData {
    try {
      if (fs.existsSync(codebotPath('profile.json'))) {
        const raw = fs.readFileSync(codebotPath('profile.json'), 'utf-8');
        const parsed = JSON.parse(raw) as UserProfileData;
        // Ensure all fields exist (migration safety)
        return {
          ...defaultProfile(),
          ...parsed,
          preferences: { ...defaultProfile().preferences, ...parsed.preferences },
        };
      }
    } catch { /* corrupted or missing */ }
    return defaultProfile();
  }

  /** Save profile to disk */
  save(): void {
    this.data.updatedAt = new Date().toISOString();
    const dir = path.dirname(codebotPath('profile.json'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(codebotPath('profile.json'), JSON.stringify(this.data, null, 2));
    this.dirty = false;
  }

  /** Get the full profile data */
  getData(): UserProfileData {
    return this.data;
  }

  /** Update preferences */
  updatePreferences(prefs: Partial<UserPreferences>): void {
    Object.assign(this.data.preferences, prefs);
    this.dirty = true;
    this.save();
      this.lastSaveTime = Date.now();
  }

  /** Track a common action */
  trackAction(action: string): void {
    this.data.commonActions[action] = (this.data.commonActions[action] || 0) + 1;
    this.dirty = true;
  }

  /** Add a learned pattern (max 50 patterns to keep profile compact) */
  addPattern(type: LearnedPattern['type'], content: string): void {
    // Avoid duplicates
    const exists = this.data.patterns.some(p => p.type === type && p.content === content);
    if (exists) return;

    this.data.patterns.push({
      type,
      content,
      learnedAt: new Date().toISOString(),
    });

    // Keep only the most recent 50 patterns
    if (this.data.patterns.length > 50) {
      this.data.patterns = this.data.patterns.slice(-50);
    }

    this.dirty = true;
  }

  /** Add a connected service */
  addConnectedService(service: string): void {
    if (!this.data.connectedServices.includes(service)) {
      this.data.connectedServices.push(service);
      this.dirty = true;
      this.save();
      this.lastSaveTime = Date.now();
    }
  }

  /**
   * Learn from a conversation message.
   * Extracts preferences, corrections, and patterns from user messages.
   */
  learnFromMessage(role: string, content: string): void {
    if (role !== 'user' || !content || typeof content !== 'string') return;

    const lower = content.toLowerCase();

    // Detect platform preferences
    const platformMap: Record<string, string> = {
      twitter: 'twitter', 'x.com': 'twitter', tweet: 'twitter',
      github: 'github', 'pull request': 'github', pr: 'github',
      gmail: 'gmail', email: 'gmail',
      slack: 'slack',
      notion: 'notion',
      linkedin: 'linkedin',
    };

    for (const [keyword, platform] of Object.entries(platformMap)) {
      if (lower.includes(keyword) && !this.data.connectedServices.includes(platform)) {
        this.data.connectedServices.push(platform);
        this.dirty = true;
      }
    }

    // Detect corrections ("I meant", "no, I want", "actually")
    if (/\b(i meant|no,? i want|actually,? i|please (don't|stop)|instead of)\b/i.test(content)) {
      this.addPattern('correction', content.substring(0, 200));
    }

    // Detect style preferences
    if (/\b(keep it (short|brief|concise))\b/i.test(content)) {
      this.data.preferences.verbosity = 'concise';
      this.dirty = true;
    } else if (/\b(more detail|explain more|be (more )?thorough)\b/i.test(content)) {
      this.data.preferences.verbosity = 'detailed';
      this.dirty = true;
    }

    if (/\b(casual|informal|chill)\b/i.test(lower) && /\b(tone|style|write|sound)\b/i.test(lower)) {
      this.data.preferences.writingStyle = 'casual';
      this.dirty = true;
    } else if (/\b(formal|professional|business)\b/i.test(lower) && /\b(tone|style|write|sound)\b/i.test(lower)) {
      this.data.preferences.writingStyle = 'formal';
      this.dirty = true;
    }

    // Track common action types
    if (/\b(post|tweet|share)\b/i.test(lower)) this.trackAction('social_media');
    if (/\b(research|search|find out|look up)\b/i.test(lower)) this.trackAction('research');
    if (/\b(write|draft|compose|create)\b/i.test(lower)) this.trackAction('content_creation');
    if (/\b(remind|schedule|alarm)\b/i.test(lower)) this.trackAction('scheduling');
    if (/\b(code|debug|fix|test|build)\b/i.test(lower)) this.trackAction('coding');

    // Save periodically when dirty
    if (this.dirty && (!this.lastSaveTime || Date.now() - this.lastSaveTime > 30_000)) {
      this.save();
      this.lastSaveTime = Date.now();
    }
  }

  /**
   * Generate a system prompt block with user profile context.
   */
  getPromptBlock(): string {
    const parts: string[] = [];
    const prefs = this.data.preferences;

    if (prefs.name) {
      parts.push(`User name: ${prefs.name}`);
    }
    if (prefs.timezone) {
      parts.push(`Timezone: ${prefs.timezone}`);
    }
    if (prefs.writingStyle) {
      parts.push(`Preferred writing style: ${prefs.writingStyle}`);
    }
    if (prefs.verbosity) {
      parts.push(`Preferred verbosity: ${prefs.verbosity}`);
    }
    if (prefs.language) {
      parts.push(`Preferred language: ${prefs.language}`);
    }
    if (prefs.interests && prefs.interests.length > 0) {
      parts.push(`Interests: ${prefs.interests.join(', ')}`);
    }
    if (prefs.platforms && prefs.platforms.length > 0) {
      parts.push(`Platforms used: ${prefs.platforms.join(', ')}`);
    }

    // Top actions
    const topActions = Object.entries(this.data.commonActions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([action, count]) => `${action} (${count}x)`);
    if (topActions.length > 0) {
      parts.push(`Common tasks: ${topActions.join(', ')}`);
    }

    // Connected services
    if (this.data.connectedServices.length > 0) {
      parts.push(`Connected: ${this.data.connectedServices.join(', ')}`);
    }

    // Learned patterns (corrections and preferences only — most recent 5)
    const recentPatterns = this.data.patterns
      .filter(p => p.type === 'correction' || p.type === 'preference')
      .slice(-5);
    if (recentPatterns.length > 0) {
      parts.push('Learned preferences:\n' + recentPatterns.map(p => `- ${p.content}`).join('\n'));
    }

    if (parts.length === 0) return '';
    return `\n\n--- User Profile ---\n${parts.join('\n')}`;
  }
}
