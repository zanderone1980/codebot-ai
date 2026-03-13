/**
 * Skills System — Composable multi-step workflows for CodeBot.
 *
 * Skills are JSON definitions that chain tool calls together.
 * Loaded from ~/.codebot/skills/*.json with built-in defaults.
 *
 * Template variables:
 *   {{input.field}}  — resolved from skill execution args
 *   {{prev.output}}  — output from the previous step
 *   {{prev.success}} — "true" if previous step didn't start with "Error:"
 */

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from './types';
import { codebotPath } from './paths';



export interface SkillStep {
  /** Tool name or 'app.<connector>.<action>' */
  tool: string;
  /** Arguments — can contain {{input.field}}, {{prev.output}}, {{prev.success}} */
  args: Record<string, unknown>;
  /** Optional condition: skip step if condition is "false" */
  condition?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  /** Regex pattern to auto-detect from user input */
  trigger?: string;
  /** JSON Schema for skill input parameters */
  parameters?: Record<string, unknown>;
  steps: SkillStep[];
}

/** Built-in skill definitions (used when ~/.codebot/skills/ is empty or missing) */
const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: 'pr-review-notify',
    description: 'Review a GitHub PR and post a summary to Slack',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repo owner' },
        repo: { type: 'string', description: 'Repo name' },
        channel: { type: 'string', description: 'Slack channel for notification' },
      },
      required: ['owner', 'repo', 'channel'],
    },
    steps: [
      {
        tool: 'app',
        args: { action: 'github.list_prs', owner: '{{input.owner}}', repo: '{{input.repo}}', state: 'open', per_page: 5 },
      },
      {
        tool: 'app',
        args: { action: 'slack.post_message', channel: '{{input.channel}}', message: 'PR Summary for {{input.owner}}/{{input.repo}}:\n{{prev.output}}' },
        condition: '{{prev.success}}',
      },
    ],
  },
  {
    name: 'bug-report',
    description: 'Create a bug report on both GitHub and Jira simultaneously',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'GitHub repo owner' },
        repo: { type: 'string', description: 'GitHub repo name' },
        project: { type: 'string', description: 'Jira project key' },
        title: { type: 'string', description: 'Bug title' },
        body: { type: 'string', description: 'Bug description' },
      },
      required: ['title', 'body'],
    },
    steps: [
      {
        tool: 'app',
        args: { action: 'github.create_issue', owner: '{{input.owner}}', repo: '{{input.repo}}', title: '{{input.title}}', body: '{{input.body}}', labels: 'bug' },
        condition: '{{input.owner}}',
      },
      {
        tool: 'app',
        args: { action: 'jira.create_issue', project: '{{input.project}}', summary: '{{input.title}}', description: '{{input.body}}', issuetype: 'Bug' },
        condition: '{{input.project}}',
      },
    ],
  },
  {
    name: 'standup-summary',
    description: 'Generate a standup summary from recent git activity and post to Slack',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel for standup' },
        days: { type: 'number', description: 'Number of days to look back (default 1)' },
      },
      required: ['channel'],
    },
    steps: [
      {
        tool: 'execute',
        args: { command: 'git log --oneline --since="{{input.days}} days ago" --no-merges 2>/dev/null | head -15 || echo "No recent commits"' },
      },
      {
        tool: 'app',
        args: { action: 'slack.post_message', channel: '{{input.channel}}', message: 'Standup Summary:\n{{prev.output}}' },
        condition: '{{prev.success}}',
      },
    ],
  },
];

/**
 * Resolve template variables in a value.
 * Handles strings with {{input.field}}, {{prev.output}}, {{prev.success}}.
 */
function resolveTemplate(
  value: unknown,
  input: Record<string, unknown>,
  prevOutput: string,
  prevSuccess: boolean,
): unknown {
  if (typeof value !== 'string') return value;

  let result = value;

  // Replace {{input.field}} patterns
  result = result.replace(/\{\{input\.(\w+)\}\}/g, (_match, field) => {
    const val = input[field];
    return val !== undefined && val !== null ? String(val) : '';
  });

  // Replace {{prev.output}} and {{prev.success}}
  result = result.replace(/\{\{prev\.output\}\}/g, prevOutput);
  result = result.replace(/\{\{prev\.success\}\}/g, String(prevSuccess));

  return result;
}

/**
 * Load skill definitions from ~/.codebot/skills/ directory.
 * Returns built-in defaults if directory is empty or missing.
 */
export function loadSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  // Load user-defined skills
  try {
    if (fs.existsSync(codebotPath('skills'))) {
      const files = fs.readdirSync(codebotPath('skills')).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(codebotPath('skills'), file), 'utf-8');
          const skill = JSON.parse(raw) as SkillDefinition;
          if (skill.name && skill.steps?.length) {
            skills.push(skill);
          }
        } catch { /* skip invalid skill files */ }
      }
    }
  } catch { /* skills dir unavailable */ }

  // Add built-in skills that aren't overridden by user skills
  const userNames = new Set(skills.map(s => s.name));
  for (const builtin of BUILTIN_SKILLS) {
    if (!userNames.has(builtin.name)) {
      skills.push(builtin);
    }
  }

  return skills;
}

/**
 * Convert a skill definition into a Tool that can be registered in ToolRegistry.
 *
 * @param skill The skill definition
 * @param executeTool Callback to execute a tool by name (bridges to ToolRegistry)
 */
export function skillToTool(
  skill: SkillDefinition,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
): Tool {
  return {
    name: `skill_${skill.name}`,
    description: `[Skill] ${skill.description}`,
    permission: 'prompt' as const,
    parameters: skill.parameters || { type: 'object', properties: {} },

    async execute(args: Record<string, unknown>): Promise<string> {
      const results: string[] = [];
      let prevOutput = '';
      let prevSuccess = true;

      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i];

        // Check condition
        if (step.condition) {
          const resolved = resolveTemplate(step.condition, args, prevOutput, prevSuccess) as string;
          // Skip step if condition resolves to empty, "false", or "undefined"
          if (!resolved || resolved === 'false' || resolved === 'undefined' || resolved === '') {
            results.push(`Step ${i + 1} (${step.tool}): skipped (condition not met)`);
            continue;
          }
        }

        // Resolve template variables in args
        const resolvedArgs: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(step.args)) {
          resolvedArgs[key] = resolveTemplate(val, args, prevOutput, prevSuccess);
        }

        // Execute the step
        try {
          const output = await executeTool(step.tool, resolvedArgs);
          prevOutput = output;
          prevSuccess = !output.startsWith('Error:');
          results.push(`Step ${i + 1} (${step.tool}): ${output}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          prevOutput = `Error: ${errMsg}`;
          prevSuccess = false;
          results.push(`Step ${i + 1} (${step.tool}): Error: ${errMsg}`);
        }
      }

      return results.join('\n---\n');
    },
  };
}
