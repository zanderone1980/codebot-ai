/**
 * Workflows System — Pre-built one-click actions for the dashboard.
 *
 * Workflows extend SkillDefinitions with UI metadata (icon, category, color, inputFields)
 * so the dashboard can render them as clickable cards with input forms.
 *
 * Users can also create custom workflows in ~/.codebot/workflows/*.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WORKFLOWS_DIR = path.join(os.homedir(), '.codebot', 'workflows');

export interface WorkflowInputField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  placeholder?: string;
  required?: boolean;
  options?: string[];  // for select type
  default?: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  /** Category for grouping in the UI */
  category: 'social' | 'research' | 'productivity' | 'dev' | 'creative' | 'system';
  /** SVG icon name (mapped in frontend) */
  icon: string;
  /** Accent color for the card */
  color: string;
  /** Input fields shown in the runner form */
  inputFields: WorkflowInputField[];
  /** The prompt template sent to the agent. Uses {{fieldName}} placeholders. */
  promptTemplate: string;
}

/** Category display metadata */
export const WORKFLOW_CATEGORIES: Record<string, { label: string; color: string }> = {
  social: { label: 'Social', color: '#3b82f6' },
  research: { label: 'Research', color: '#8b5cf6' },
  productivity: { label: 'Productivity', color: '#22c55e' },
  dev: { label: 'Dev', color: '#06b6d4' },
  creative: { label: 'Creative', color: '#f59e0b' },
  system: { label: 'System', color: '#6b7280' },
};

/** Built-in workflow definitions */
const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'post-on-x',
    description: 'Compose and post a tweet on X (Twitter)',
    category: 'social',
    icon: 'send',
    color: '#3b82f6',
    inputFields: [
      { name: 'topic', label: 'Topic or message', type: 'text', placeholder: 'What to post about...', required: true },
      { name: 'tone', label: 'Tone', type: 'select', options: ['Professional', 'Casual', 'Witty', 'Informative'], default: 'Professional' },
    ],
    promptTemplate: 'Compose and post a tweet on X about: {{topic}}. Use a {{tone}} tone. Keep it concise and engaging. Use the x_post tool to publish it.',
  },
  {
    name: 'schedule-x-thread',
    description: 'Write a multi-tweet thread for X',
    category: 'social',
    icon: 'list',
    color: '#3b82f6',
    inputFields: [
      { name: 'topic', label: 'Thread topic', type: 'text', placeholder: 'What the thread is about...', required: true },
      { name: 'points', label: 'Key points (one per line)', type: 'textarea', placeholder: 'Point 1\nPoint 2\nPoint 3' },
      { name: 'tweets', label: 'Number of tweets', type: 'number', default: '5' },
    ],
    promptTemplate: 'Write a {{tweets}}-tweet thread for X about: {{topic}}. Key points to cover: {{points}}. Post the first tweet with x_post, then reply to it for the thread. Make it engaging and informative.',
  },
  {
    name: 'research-topic',
    description: 'Deep research on any topic with sources',
    category: 'research',
    icon: 'search',
    color: '#8b5cf6',
    inputFields: [
      { name: 'topic', label: 'Research topic', type: 'text', placeholder: 'What to research...', required: true },
      { name: 'depth', label: 'Depth', type: 'select', options: ['Quick overview', 'Detailed analysis', 'Comprehensive report'], default: 'Detailed analysis' },
      { name: 'format', label: 'Output format', type: 'select', options: ['Summary', 'Bullet points', 'Full report'], default: 'Summary' },
    ],
    promptTemplate: 'Research the following topic: {{topic}}. Provide a {{depth}} in {{format}} format. Use web_search and web_fetch to find current, reliable sources. Include key findings, data points, and source URLs.',
  },
  {
    name: 'generate-image',
    description: 'Generate an AI image from a text description',
    category: 'creative',
    icon: 'image',
    color: '#f59e0b',
    inputFields: [
      { name: 'description', label: 'Image description', type: 'textarea', placeholder: 'Describe the image you want...', required: true },
      { name: 'style', label: 'Style', type: 'select', options: ['Photorealistic', 'Digital art', 'Illustration', 'Minimalist', 'Abstract'], default: 'Digital art' },
      { name: 'size', label: 'Size', type: 'select', options: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024' },
    ],
    promptTemplate: 'Generate an image using the openai_images tool: {{description}}. Style: {{style}}. Size: {{size}}.',
  },
  {
    name: 'git-summary',
    description: 'Summarize recent git activity',
    category: 'dev',
    icon: 'git',
    color: '#06b6d4',
    inputFields: [
      { name: 'days', label: 'Days to look back', type: 'number', default: '7' },
      { name: 'detail', label: 'Detail level', type: 'select', options: ['Brief', 'Detailed', 'With diffs'], default: 'Brief' },
    ],
    promptTemplate: 'Summarize git activity from the last {{days}} days. Detail level: {{detail}}. Use the execute tool to run git log and git diff commands. Include commit count, files changed, and key changes.',
  },
  {
    name: 'check-website',
    description: 'Check if a website is up and analyze it',
    category: 'system',
    icon: 'globe',
    color: '#6b7280',
    inputFields: [
      { name: 'url', label: 'Website URL', type: 'text', placeholder: 'https://example.com', required: true },
      { name: 'checks', label: 'What to check', type: 'select', options: ['Status only', 'Content analysis', 'Full audit'], default: 'Content analysis' },
    ],
    promptTemplate: 'Check the website at {{url}}. Analysis level: {{checks}}. Use web_fetch to load the page. Report: status code, load time, main content summary, and any issues found.',
  },
  {
    name: 'daily-digest',
    description: 'Generate a daily digest of system activity',
    category: 'productivity',
    icon: 'clipboard',
    color: '#22c55e',
    inputFields: [],
    promptTemplate: 'Generate a daily digest. Check: 1) Recent git commits (last 24h), 2) System health (disk, memory via execute tool), 3) Any scheduled routines and their status. Present as a clean, readable summary.',
  },
  {
    name: 'write-content',
    description: 'Write a blog post, article, or document',
    category: 'creative',
    icon: 'edit',
    color: '#f59e0b',
    inputFields: [
      { name: 'type', label: 'Content type', type: 'select', options: ['Blog post', 'Article', 'Documentation', 'Email draft', 'Social media copy'], default: 'Blog post' },
      { name: 'topic', label: 'Topic', type: 'text', placeholder: 'What to write about...', required: true },
      { name: 'length', label: 'Length', type: 'select', options: ['Short (200 words)', 'Medium (500 words)', 'Long (1000+ words)'], default: 'Medium (500 words)' },
      { name: 'audience', label: 'Target audience', type: 'text', placeholder: 'e.g., developers, general public', default: 'General audience' },
    ],
    promptTemplate: 'Write a {{type}} about: {{topic}}. Target length: {{length}}. Audience: {{audience}}. Make it engaging and well-structured with a clear introduction, body, and conclusion.',
  },
];

/**
 * Load workflow definitions from ~/.codebot/workflows/ + built-ins.
 */
export function loadWorkflows(): WorkflowDefinition[] {
  const workflows: WorkflowDefinition[] = [];

  // Load user-defined workflows
  try {
    if (fs.existsSync(WORKFLOWS_DIR)) {
      const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
          const wf = JSON.parse(raw) as WorkflowDefinition;
          if (wf.name && wf.promptTemplate) {
            workflows.push(wf);
          }
        } catch { /* skip invalid workflow files */ }
      }
    }
  } catch { /* workflows dir unavailable */ }

  // Add built-in workflows that aren't overridden
  const userNames = new Set(workflows.map(w => w.name));
  for (const builtin of BUILTIN_WORKFLOWS) {
    if (!userNames.has(builtin.name)) {
      workflows.push(builtin);
    }
  }

  return workflows;
}

/**
 * Get a single workflow by name.
 */
export function getWorkflow(name: string): WorkflowDefinition | undefined {
  return loadWorkflows().find(w => w.name === name);
}

/**
 * Resolve a workflow's prompt template with input values.
 */
export function resolveWorkflowPrompt(workflow: WorkflowDefinition, inputs: Record<string, string>): string {
  let prompt = workflow.promptTemplate;

  for (const field of workflow.inputFields) {
    const value = inputs[field.name] || field.default || '';
    prompt = prompt.replace(new RegExp(`\\{\\{${field.name}\\}\\}`, 'g'), value);
  }

  return prompt;
}
