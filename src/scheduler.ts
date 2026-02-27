import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Routine, matchesCron } from './tools/routine';
import { Agent } from './agent';
import { AgentEvent } from './types';

const ROUTINES_FILE = path.join(os.homedir(), '.codebot', 'routines.json');

export class Scheduler {
  private agent: Agent;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onOutput?: (text: string) => void;

  constructor(agent: Agent, onOutput?: (text: string) => void) {
    this.agent = agent;
    this.onOutput = onOutput;
  }

  /** Start the scheduler — checks routines every 60 seconds */
  start(): void {
    if (this.interval) return;

    // Check every 60 seconds
    this.interval = setInterval(() => this.tick(), 60_000);

    // Also do an immediate check
    this.tick();
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Check if any routines need to run right now */
  private tick(): void {
    if (this.running) return; // Don't run if already executing a routine

    const routines = this.loadRoutines();
    const now = new Date();

    for (const routine of routines) {
      if (!routine.enabled) continue;

      // Check if the cron schedule matches current time
      if (!matchesCron(routine.schedule, now)) continue;

      // Don't re-run if already ran this minute
      if (routine.lastRun) {
        const lastRun = new Date(routine.lastRun);
        const diffMs = now.getTime() - lastRun.getTime();
        if (diffMs < 60_000) continue; // Already ran this minute
      }

      // Run the routine
      this.executeRoutine(routine, routines);
      break; // Only run one routine per tick to avoid conflicts
    }
  }

  private async executeRoutine(routine: Routine, allRoutines: Routine[]): Promise<void> {
    this.running = true;

    try {
      this.onOutput?.(`\n⏰ Running routine: ${routine.name}\n   Task: ${routine.prompt}\n`);

      // Run the agent with the routine's prompt
      for await (const event of this.agent.run(routine.prompt) as AsyncGenerator<AgentEvent>) {
        switch (event.type) {
          case 'text':
            this.onOutput?.(event.text || '');
            break;
          case 'tool_call':
            this.onOutput?.(`\n⚡ ${event.toolCall?.name}(${Object.entries(event.toolCall?.args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 40) : v}`).join(', ')})\n`);
            break;
          case 'tool_result':
            this.onOutput?.(`  ✓ ${event.toolResult?.result?.substring(0, 100) || ''}\n`);
            break;
          case 'error':
            this.onOutput?.(`  ✗ Error: ${event.error}\n`);
            break;
        }
      }

      // Update last run time
      routine.lastRun = new Date().toISOString();
      this.saveRoutines(allRoutines);

      this.onOutput?.(`\n✓ Routine "${routine.name}" completed.\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onOutput?.(`\n✗ Routine "${routine.name}" failed: ${msg}\n`);
    } finally {
      this.running = false;
    }
  }

  private loadRoutines(): Routine[] {
    try {
      if (fs.existsSync(ROUTINES_FILE)) {
        return JSON.parse(fs.readFileSync(ROUTINES_FILE, 'utf-8'));
      }
    } catch { /* corrupt file */ }
    return [];
  }

  private saveRoutines(routines: Routine[]): void {
    const dir = path.dirname(ROUTINES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ROUTINES_FILE, JSON.stringify(routines, null, 2) + '\n');
  }
}
