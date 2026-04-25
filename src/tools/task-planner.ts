import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

interface Task {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'high' | 'medium' | 'low';
  created: string;
  completed?: string;
}

const TASKS_DIR = path.join(process.cwd(), '.codebot');
const TASKS_FILE = path.join(TASKS_DIR, 'tasks.json');

export class TaskPlannerTool implements Tool {
  name = 'task_planner';
  description = 'Plan and track tasks. Actions: add, list, update, complete, remove, clear.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['write-fs'];
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: add, list, update, complete, remove, clear' },
      title: { type: 'string', description: 'Task title (for add action)' },
      id: { type: 'number', description: 'Task ID (for update/complete/remove)' },
      priority: { type: 'string', description: 'Priority: high, medium, low (default: medium)' },
      status: { type: 'string', description: 'New status for update action' },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    if (!action) return 'Error: action is required';

    switch (action) {
      case 'add': return this.addTask(args);
      case 'list': return this.listTasks();
      case 'update': return this.updateTask(args);
      case 'complete': return this.completeTask(args);
      case 'remove': return this.removeTask(args);
      case 'clear': return this.clearDone();
      default: return `Error: unknown action "${action}". Use: add, list, update, complete, remove, clear`;
    }
  }

  private addTask(args: Record<string, unknown>): string {
    const title = args.title as string;
    if (!title) return 'Error: title is required for add';

    const tasks = this.load();
    const id = tasks.length > 0 ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
    const priority = (['high', 'medium', 'low'].includes(args.priority as string) ? args.priority : 'medium') as Task['priority'];

    tasks.push({ id, title, status: 'pending', priority, created: new Date().toISOString() });
    this.save(tasks);
    return `Added task #${id}: ${title} [${priority}]`;
  }

  private listTasks(): string {
    const tasks = this.load();
    if (tasks.length === 0) return 'No tasks.';

    const icons: Record<string, string> = { pending: '○', in_progress: '◐', done: '●' };
    const priIcons: Record<string, string> = { high: '!!!', medium: '!!', low: '!' };

    const lines = tasks.map(t =>
      `  ${icons[t.status] || '○'} #${t.id} [${priIcons[t.priority] || '!!'}] ${t.title} (${t.status})`
    );

    const pending = tasks.filter(t => t.status === 'pending').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const done = tasks.filter(t => t.status === 'done').length;

    return `Tasks (${pending} pending, ${inProgress} active, ${done} done):\n${lines.join('\n')}`;
  }

  private updateTask(args: Record<string, unknown>): string {
    const id = args.id as number;
    if (!id) return 'Error: id is required for update';

    const tasks = this.load();
    const task = tasks.find(t => t.id === id);
    if (!task) return `Error: task #${id} not found`;

    if (args.status && ['pending', 'in_progress', 'done'].includes(args.status as string)) {
      task.status = args.status as Task['status'];
      if (task.status === 'done') task.completed = new Date().toISOString();
    }
    if (args.title) task.title = args.title as string;
    if (args.priority && ['high', 'medium', 'low'].includes(args.priority as string)) {
      task.priority = args.priority as Task['priority'];
    }

    this.save(tasks);
    return `Updated task #${id}: ${task.title} (${task.status})`;
  }

  private completeTask(args: Record<string, unknown>): string {
    const id = args.id as number;
    if (!id) return 'Error: id is required for complete';

    const tasks = this.load();
    const task = tasks.find(t => t.id === id);
    if (!task) return `Error: task #${id} not found`;

    task.status = 'done';
    task.completed = new Date().toISOString();
    this.save(tasks);
    return `Completed task #${id}: ${task.title}`;
  }

  private removeTask(args: Record<string, unknown>): string {
    const id = args.id as number;
    if (!id) return 'Error: id is required for remove';

    const tasks = this.load();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return `Error: task #${id} not found`;

    const removed = tasks.splice(idx, 1)[0];
    this.save(tasks);
    return `Removed task #${id}: ${removed.title}`;
  }

  private clearDone(): string {
    const tasks = this.load();
    const before = tasks.length;
    const remaining = tasks.filter(t => t.status !== 'done');
    this.save(remaining);
    return `Cleared ${before - remaining.length} completed tasks. ${remaining.length} remaining.`;
  }

  private load(): Task[] {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
      }
    } catch { /* corrupt */ }
    return [];
  }

  private save(tasks: Task[]): void {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2) + '\n');
  }
}
