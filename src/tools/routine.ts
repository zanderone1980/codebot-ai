import { Tool, CapabilityLabel } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from '../paths';
import { warnNonFatal } from '../warn';
import * as crypto from 'crypto';

export interface Routine {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string;       // Cron expression: "0 9 * * *" = 9am daily
  lastRun?: string;       // ISO timestamp
  enabled: boolean;
}



export class RoutineTool implements Tool {
  name = 'routine';
  description = 'Manage scheduled routines (recurring tasks). Add daily social media posts, email checks, research tasks, etc. Uses cron expressions for scheduling (e.g., "0 9 * * *" for 9am daily, "0 */6 * * *" for every 6 hours, "30 18 * * 1-5" for 6:30pm weekdays).';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['write-fs'];
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: ['list', 'add', 'remove', 'enable', 'disable'],
      },
      name: { type: 'string', description: 'Routine name (for add/remove)' },
      description: { type: 'string', description: 'Human-readable description (for add)' },
      prompt: { type: 'string', description: 'The message/task to execute when triggered (for add)' },
      schedule: { type: 'string', description: 'Cron expression: "minute hour day-of-month month day-of-week" (for add)' },
      id: { type: 'string', description: 'Routine ID (for remove/enable/disable)' },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    switch (action) {
      case 'list':
        return this.list();
      case 'add':
        return this.add(args);
      case 'remove':
        return this.remove(args.id as string || args.name as string);
      case 'enable':
        return this.toggle(args.id as string || args.name as string, true);
      case 'disable':
        return this.toggle(args.id as string || args.name as string, false);
      default:
        return `Unknown action: ${action}. Use: list, add, remove, enable, disable`;
    }
  }

  private loadRoutines(): Routine[] {
    try {
      if (fs.existsSync(codebotPath('routines.json'))) {
        return JSON.parse(fs.readFileSync(codebotPath('routines.json'), 'utf-8'));
      }
    } catch { /* corrupt file */ }
    return [];
  }

  private saveRoutines(routines: Routine[]): void {
    const dir = path.dirname(codebotPath('routines.json'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(codebotPath('routines.json'), JSON.stringify(routines, null, 2) + '\n');
  }

  private list(): string {
    const routines = this.loadRoutines();
    if (routines.length === 0) {
      return 'No routines configured. Use action "add" to create one.';
    }

    return routines.map(r => {
      const status = r.enabled ? '✓ enabled' : '✗ disabled';
      const lastRun = r.lastRun ? `Last run: ${r.lastRun}` : 'Never run';
      return `[${r.id.substring(0, 8)}] ${r.name} (${status})\n  Schedule: ${r.schedule}\n  Task: ${r.prompt.substring(0, 100)}${r.prompt.length > 100 ? '...' : ''}\n  ${lastRun}`;
    }).join('\n\n');
  }

  private add(args: Record<string, unknown>): string {
    const name = args.name as string;
    const description = args.description as string || '';
    const prompt = args.prompt as string;
    const schedule = args.schedule as string;

    if (!name) return 'Error: name is required';
    if (!prompt) return 'Error: prompt is required (the task to execute)';
    if (!schedule) return 'Error: schedule is required (cron expression)';

    // Validate cron expression
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      return 'Error: schedule must be a 5-field cron expression: "minute hour day-of-month month day-of-week"';
    }

    const routines = this.loadRoutines();

    // Check for duplicate name
    if (routines.find(r => r.name.toLowerCase() === name.toLowerCase())) {
      return `Error: routine "${name}" already exists. Remove it first or use a different name.`;
    }

    const routine: Routine = {
      id: crypto.randomUUID(),
      name,
      description,
      prompt,
      schedule: schedule.trim(),
      enabled: true,
    };

    routines.push(routine);
    this.saveRoutines(routines);

    return `Routine "${name}" created!\n  ID: ${routine.id.substring(0, 8)}\n  Schedule: ${schedule}\n  Task: ${prompt.substring(0, 100)}`;
  }

  private remove(identifier: string): string {
    if (!identifier) return 'Error: id or name is required';

    const routines = this.loadRoutines();
    const idx = routines.findIndex(r =>
      r.id === identifier || r.id.startsWith(identifier) || r.name.toLowerCase() === identifier.toLowerCase()
    );

    if (idx === -1) return `Routine "${identifier}" not found.`;

    const removed = routines.splice(idx, 1)[0];
    this.saveRoutines(routines);

    return `Removed routine: ${removed.name}`;
  }

  private toggle(identifier: string, enabled: boolean): string {
    if (!identifier) return 'Error: id or name is required';

    const routines = this.loadRoutines();
    const routine = routines.find(r =>
      r.id === identifier || r.id.startsWith(identifier) || r.name.toLowerCase() === identifier.toLowerCase()
    );

    if (!routine) return `Routine "${identifier}" not found.`;

    routine.enabled = enabled;
    this.saveRoutines(routines);

    return `Routine "${routine.name}" ${enabled ? 'enabled' : 'disabled'}.`;
  }
}

/** Check if a cron expression matches the given date */
export function matchesCron(expr: string, date: Date): boolean {
  const [minField, hourField, domField, monthField, dowField] = expr.split(/\s+/);
  const checks: [string, number][] = [
    [minField, date.getMinutes()],
    [hourField, date.getHours()],
    [domField, date.getDate()],
    [monthField, date.getMonth() + 1],
    [dowField, date.getDay()],
  ];

  return checks.every(([field, val]) => matchField(field, val));
}

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;

  // Handle step values: */5, */10
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }

  // Handle ranges: 1-5
  if (field.includes('-')) {
    const [low, high] = field.split('-').map(Number);
    return value >= low && value <= high;
  }

  // Handle lists: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }

  // Exact match
  return parseInt(field, 10) === value;
}
