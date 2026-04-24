/**
 * SkillForge Tool — Self-authoring skill system for CodeBot.
 *
 * Allows the agent (or CodeAGI) to create new reusable skills at runtime.
 * Skills are written to ~/.codebot/skills/<name>.json and become available
 * as `skill_<name>` tools on next session load.
 *
 * Shared skill spec includes metadata for cross-system reinforcement:
 *   - author: "codebot" | "codeagi" | "user"
 *   - confidence: 0.0-1.0 (increases with successful use)
 *   - use_count: number of times the skill has been invoked
 *   - origin: how the skill was created (e.g., "forged", "promoted", "manual")
 *   - created_at / updated_at: ISO timestamps
 */

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';
import { codebotPath } from '../paths';

interface ForgedSkill {
  name: string;
  description: string;
  trigger?: string;
  parameters?: Record<string, unknown>;
  steps: Array<{
    tool: string;
    args: Record<string, unknown>;
    condition?: string;
  }>;
  // Shared metadata
  author: 'codebot' | 'codeagi' | 'user';
  confidence: number;
  use_count: number;
  origin: string;
  created_at: string;
  updated_at: string;
}

/**
 * Validate a skill *name* — must be usable as a filename AND safe to
 * interpolate into path.join without escaping the skills dir. Single
 * source of truth used by every op that touches `<name>.json` on disk.
 *
 * 2026-04-23 hardening: before this, only _create called the pattern
 * (indirectly via validateSkill). reinforceSkill / _delete / _inspect
 * accepted a raw `name` and did `path.join(skillsDir, \`${name}.json\`)`
 * — a name of `../../../tmp/pwn` resolved OUTSIDE the skills dir, so
 * the agent could unlink / read / overwrite arbitrary .json files on
 * the user's machine. Traversal closed by routing every op through
 * isValidSkillName first.
 */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
function isValidSkillName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && SKILL_NAME_RE.test(name);
}

/** Validate a skill definition before writing */
function validateSkill(skill: Record<string, unknown>): string | null {
  if (!skill.name || typeof skill.name !== 'string') {
    return 'Skill must have a non-empty string "name"';
  }
  if (!isValidSkillName(skill.name)) {
    return 'Skill name must only contain a-z, 0-9, hyphens, and underscores';
  }
  if (!skill.description || typeof skill.description !== 'string') {
    return 'Skill must have a non-empty string "description"';
  }
  if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
    return 'Skill must have at least one step';
  }
  for (let i = 0; i < (skill.steps as unknown[]).length; i++) {
    const step = (skill.steps as Record<string, unknown>[])[i];
    if (!step || typeof step !== 'object') {
      return `Step ${i + 1} must be an object`;
    }
    if (!step.tool || typeof step.tool !== 'string') {
      return `Step ${i + 1} must have a "tool" string`;
    }
    if (!step.args || typeof step.args !== 'object') {
      return `Step ${i + 1} must have an "args" object`;
    }
  }
  if (skill.parameters) {
    if (typeof skill.parameters !== 'object') return '"parameters" must be an object';
    const params = skill.parameters as Record<string, unknown>;
    if (params.type !== 'object') return '"parameters.type" must be "object"';
    if (!params.properties || typeof params.properties !== 'object') {
      return '"parameters.properties" must be an object';
    }
  }
  if (skill.trigger && typeof skill.trigger !== 'string') {
    return '"trigger" must be a string (regex pattern)';
  }
  return null;
}

/** List all forged skills with their metadata */
function listSkills(): ForgedSkill[] {
  const skillsDir = codebotPath('skills');
  if (!fs.existsSync(skillsDir)) return [];

  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));
  const skills: ForgedSkill[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
      const skill = JSON.parse(raw) as ForgedSkill;
      if (skill.name && skill.steps?.length) {
        skills.push(skill);
      }
    } catch { /* skip invalid */ }
  }

  return skills;
}

/** Reinforce a skill (bump confidence and use_count) */
function reinforceSkill(name: string, success: boolean): string {
  if (!isValidSkillName(name)) return `Error: invalid skill name — must match ${SKILL_NAME_RE}`;
  const skillPath = path.join(codebotPath('skills'), `${name}.json`);
  if (!fs.existsSync(skillPath)) return `Skill "${name}" not found`;

  try {
    const skill = JSON.parse(fs.readFileSync(skillPath, 'utf-8')) as ForgedSkill;
    skill.use_count = (skill.use_count || 0) + 1;
    if (success) {
      skill.confidence = Math.min(1.0, (skill.confidence || 0.5) + 0.05);
    } else {
      skill.confidence = Math.max(0.0, (skill.confidence || 0.5) - 0.1);
    }
    skill.updated_at = new Date().toISOString();
    fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2) + '\n');
    return `Skill "${name}" reinforced: confidence=${skill.confidence.toFixed(2)}, use_count=${skill.use_count}`;
  } catch (err) {
    return `Error reinforcing skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export class SkillForgeTool implements Tool {
  name = 'skill_forge';
  description = 'Create, list, reinforce, or delete reusable multi-step skills. Skills compose existing tools into higher-level workflows that persist across sessions. Both CodeBot and CodeAGI can author and consume skills from the shared store.';
  permission: 'prompt' = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: "create", "list", "reinforce", "delete", "inspect"',
        enum: ['create', 'list', 'reinforce', 'delete', 'inspect'],
      },
      name: {
        type: 'string',
        description: 'Skill name (required for create/reinforce/delete/inspect)',
      },
      description: {
        type: 'string',
        description: 'Skill description (required for create)',
      },
      trigger: {
        type: 'string',
        description: 'Regex pattern for auto-detection from user input (optional)',
      },
      parameters: {
        type: 'object',
        description: 'JSON Schema for skill input parameters (optional)',
      },
      steps: {
        type: 'array',
        description: 'Array of step objects: { tool, args, condition? } (required for create)',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name to invoke for this step' },
            args: { type: 'object', description: 'Arguments to pass to the tool', additionalProperties: true },
            condition: { type: 'string', description: 'Optional precondition expression' },
          },
          required: ['tool'],
        },
      },
      success: {
        type: 'boolean',
        description: 'Whether the skill execution was successful (for reinforce action)',
      },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    switch (action) {
      case 'create':
        return this._create(args);
      case 'list':
        return this._list();
      case 'reinforce':
        return reinforceSkill(args.name as string, args.success !== false);
      case 'delete':
        return this._delete(args.name as string);
      case 'inspect':
        return this._inspect(args.name as string);
      default:
        return `Unknown action "${action}". Use: create, list, reinforce, delete, inspect`;
    }
  }

  private _create(args: Record<string, unknown>): string {
    const validation = validateSkill(args);
    if (validation) return `Validation error: ${validation}`;

    const skillsDir = codebotPath('skills');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    const name = args.name as string;
    const skillPath = path.join(skillsDir, `${name}.json`);

    // Check if skill already exists
    if (fs.existsSync(skillPath)) {
      return `Skill "${name}" already exists. Delete it first or choose a different name.`;
    }

    const skill: ForgedSkill = {
      name,
      description: args.description as string,
      steps: args.steps as ForgedSkill['steps'],
      author: 'codebot',
      confidence: 0.5,
      use_count: 0,
      origin: 'forged',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (args.trigger) skill.trigger = args.trigger as string;
    if (args.parameters) skill.parameters = args.parameters as Record<string, unknown>;

    fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2) + '\n');

    return `Skill "${name}" created at ${skillPath}\n` +
      `Steps: ${skill.steps.length}\n` +
      `Available as tool: skill_${name}\n` +
      `Will be loaded on next session start.`;
  }

  private _list(): string {
    const skills = listSkills();
    if (skills.length === 0) {
      return 'No skills found in shared store. Use action "create" to forge a new skill.';
    }

    const lines = skills.map(s => {
      const meta = [
        `author=${s.author || 'unknown'}`,
        `confidence=${(s.confidence || 0).toFixed(2)}`,
        `uses=${s.use_count || 0}`,
        `origin=${s.origin || 'unknown'}`,
      ].join(', ');
      return `- ${s.name}: ${s.description} [${meta}]`;
    });

    return `Shared Skill Store (${skills.length} skills):\n${lines.join('\n')}`;
  }

  private _delete(name: string): string {
    if (!name) return 'Must provide skill name to delete';
    if (!isValidSkillName(name)) return `Error: invalid skill name — must match ${SKILL_NAME_RE}`;
    const skillPath = path.join(codebotPath('skills'), `${name}.json`);
    if (!fs.existsSync(skillPath)) return `Skill "${name}" not found`;

    fs.unlinkSync(skillPath);
    return `Skill "${name}" deleted from shared store.`;
  }

  private _inspect(name: string): string {
    if (!name) return 'Must provide skill name to inspect';
    if (!isValidSkillName(name)) return `Error: invalid skill name — must match ${SKILL_NAME_RE}`;
    const skillPath = path.join(codebotPath('skills'), `${name}.json`);
    if (!fs.existsSync(skillPath)) return `Skill "${name}" not found`;

    try {
      const raw = fs.readFileSync(skillPath, 'utf-8');
      const skill = JSON.parse(raw) as ForgedSkill;
      const lines = [
        `Name: ${skill.name}`,
        `Description: ${skill.description}`,
        `Author: ${skill.author || 'unknown'}`,
        `Origin: ${skill.origin || 'unknown'}`,
        `Confidence: ${(skill.confidence || 0).toFixed(2)}`,
        `Use Count: ${skill.use_count || 0}`,
        `Created: ${skill.created_at || 'unknown'}`,
        `Updated: ${skill.updated_at || 'unknown'}`,
        `Trigger: ${skill.trigger || 'none'}`,
        `Steps (${skill.steps.length}):`,
      ];
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i];
        lines.push(`  ${i + 1}. ${step.tool}(${JSON.stringify(step.args)})${step.condition ? ` [if: ${step.condition}]` : ''}`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Error reading skill: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
