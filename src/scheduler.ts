import * as fs from 'fs';
import * as path from 'path';
import { Routine, matchesCron } from './tools/routine';
import { Agent } from './agent';
import { AgentEvent } from './types';
import { getProactiveEngine } from './proactive';
import { codebotPath } from './paths';
import { warnNonFatal } from './warn';



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
    const ROUTINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per routine

    try {
      this.onOutput?.(`\n⏰ Running routine: ${routine.name}\n   Task: ${routine.prompt}\n`);

      // Race against a timeout so a hanging routine doesn't block the scheduler forever
      await Promise.race([
        this.runRoutineAgent(routine),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Routine timed out after ${ROUTINE_TIMEOUT_MS / 1000}s`)), ROUTINE_TIMEOUT_MS)
        ),
      ]);

      // Update last run time
      routine.lastRun = new Date().toISOString();
      this.saveRoutines(allRoutines);

      this.onOutput?.(`\n✓ Routine "${routine.name}" completed.\n`);
      getProactiveEngine().notifyRoutineComplete(routine.name, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onOutput?.(`\n✗ Routine "${routine.name}" failed: ${msg}\n`);
      getProactiveEngine().notifyRoutineComplete(routine.name, false, msg);
    } finally {
      this.running = false;
    }
  }

  /** Run the agent loop for a routine — separated so it can be wrapped in Promise.race */
  private async runRoutineAgent(routine: Routine): Promise<void> {
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
}
