/**
 * Self-Monitoring Engine — autonomous health checking and self-healing.
 *
 * Runs periodic health checks (build, tests, disk, API, memory) and
 * creates autonomous fix tasks when issues are detected. Each check
 * has a heal() method that can directly create recovery actions.
 *
 * Integrates with Scheduler for periodic checks and Agent for
 * autonomous task execution.
 */

import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { codebotPath } from './paths';

// ── Types ──

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  message: string;
  /** Suggested fix action (null if healthy) */
  fixAction?: FixAction;
  checkedAt: string;
}

export interface FixAction {
  description: string;
  /** Tool to invoke for the fix */
  tool: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
  /** Risk level — higher values need more caution */
  risk: number;
}

export interface HealthReport {
  overall: HealthStatus;
  checks: HealthCheckResult[];
  fixActions: FixAction[];
  timestamp: string;
}

export interface HealthCheck {
  name: string;
  /** How often to run (in seconds). 0 = every tick */
  intervalSeconds: number;
  lastRun?: string;
  check(): HealthCheckResult;
}

// ── Health Checks ──

export class BuildHealthCheck implements HealthCheck {
  name = 'build';
  intervalSeconds = 300; // 5 minutes
  lastRun?: string;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }

  check(): HealthCheckResult {
    const now = new Date().toISOString();
    this.lastRun = now;

    try {
      // Check if dist/ is stale compared to src/
      const srcStat = this.getLatestMtime('src');
      const distStat = this.getLatestMtime('dist');

      if (srcStat && distStat && srcStat > distStat) {
        return {
          name: this.name,
          status: 'degraded',
          message: 'Build output is stale — source files are newer than dist/',
          fixAction: {
            description: 'Rebuild the project',
            tool: 'execute',
            args: { command: 'npm run build' },
            risk: 0.2,
          },
          checkedAt: now,
        };
      }

      return { name: this.name, status: 'healthy', message: 'Build is up to date', checkedAt: now };
    } catch (err: unknown) {
      return {
        name: this.name,
        status: 'critical',
        message: `Build check failed: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt: now,
      };
    }
  }

  private getLatestMtime(dir: string): number | null {
    const fullPath = `${this.projectRoot}/${dir}`;
    if (!fs.existsSync(fullPath)) return null;

    try {
      const result = execSync(`find "${fullPath}" -name "*.ts" -o -name "*.js" | head -50 | xargs stat -f "%m" 2>/dev/null || find "${fullPath}" -name "*.ts" -o -name "*.js" -printf "%T@\n" 2>/dev/null | head -50`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const times = result.trim().split('\n').map(Number).filter(n => !isNaN(n));
      return times.length > 0 ? Math.max(...times) : null;
    } catch {
      return null;
    }
  }
}

export class TestHealthCheck implements HealthCheck {
  name = 'tests';
  intervalSeconds = 600; // 10 minutes
  lastRun?: string;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }

  check(): HealthCheckResult {
    const now = new Date().toISOString();
    this.lastRun = now;

    // Check last test run result from .codebot/health/
    const resultFile = codebotPath('health/last-test-result.json');
    try {
      if (fs.existsSync(resultFile)) {
        const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        if (data.failures > 0) {
          return {
            name: this.name,
            status: 'degraded',
            message: `${data.failures} test(s) failing out of ${data.total}`,
            fixAction: {
              description: 'Run tests and investigate failures',
              tool: 'test_runner',
              args: { command: 'npm test' },
              risk: 0.1,
            },
            checkedAt: now,
          };
        }
        return {
          name: this.name,
          status: 'healthy',
          message: `All ${data.total} tests passing`,
          checkedAt: now,
        };
      }
    } catch { /* corrupt file */ }

    return {
      name: this.name,
      status: 'healthy',
      message: 'No test results cached — will check on next run',
      checkedAt: now,
    };
  }
}

export class DiskSpaceCheck implements HealthCheck {
  name = 'disk_space';
  intervalSeconds = 300;
  lastRun?: string;

  check(): HealthCheckResult {
    const now = new Date().toISOString();
    this.lastRun = now;

    try {
      const free = os.freemem();
      const total = os.totalmem();
      // Use disk check via df for actual disk space
      const dfOutput = execSync('df -h . | tail -1', { encoding: 'utf-8', timeout: 3000 });
      const parts = dfOutput.trim().split(/\s+/);
      const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);

      if (usePercent >= 95) {
        return {
          name: this.name,
          status: 'critical',
          message: `Disk ${usePercent}% full — critically low space`,
          fixAction: {
            description: 'Clean build artifacts and caches',
            tool: 'execute',
            args: { command: 'npm cache clean --force && rm -rf node_modules/.cache' },
            risk: 0.3,
          },
          checkedAt: now,
        };
      }

      if (usePercent >= 85) {
        return {
          name: this.name,
          status: 'degraded',
          message: `Disk ${usePercent}% full — consider cleanup`,
          checkedAt: now,
        };
      }

      return {
        name: this.name,
        status: 'healthy',
        message: `Disk ${usePercent}% used, ${Math.round(free / 1024 / 1024)}MB memory free`,
        checkedAt: now,
      };
    } catch {
      return { name: this.name, status: 'healthy', message: 'Disk check unavailable', checkedAt: now };
    }
  }
}

export class APIHealthCheck implements HealthCheck {
  name = 'api';
  intervalSeconds = 300;
  lastRun?: string;
  private consecutiveFailures = 0;

  check(): HealthCheckResult {
    const now = new Date().toISOString();
    this.lastRun = now;

    // Check recent API error rate from health log
    const errorLog = codebotPath('health/api-errors.json');
    try {
      if (fs.existsSync(errorLog)) {
        const errors: Array<{ timestamp: string; error: string }> = JSON.parse(
          fs.readFileSync(errorLog, 'utf-8'),
        );
        const recent = errors.filter(e => {
          const age = Date.now() - new Date(e.timestamp).getTime();
          return age < 5 * 60 * 1000; // last 5 minutes
        });

        if (recent.length >= 5) {
          return {
            name: this.name,
            status: 'critical',
            message: `${recent.length} API errors in last 5 minutes`,
            fixAction: {
              description: 'Check API credentials and endpoint health',
              tool: 'think',
              args: { thought: `API has ${recent.length} recent errors. Last: ${recent[recent.length - 1]?.error}` },
              risk: 0.1,
            },
            checkedAt: now,
          };
        }
        if (recent.length >= 2) {
          return {
            name: this.name,
            status: 'degraded',
            message: `${recent.length} API errors in last 5 minutes`,
            checkedAt: now,
          };
        }
      }
    } catch { /* corrupt file */ }

    return { name: this.name, status: 'healthy', message: 'API healthy', checkedAt: now };
  }

  /** Record an API error for tracking */
  recordError(error: string): void {
    this.consecutiveFailures++;
    const errorLog = codebotPath('health/api-errors.json');
    try {
      const dir = codebotPath('health');
      fs.mkdirSync(dir, { recursive: true });
      const errors: Array<{ timestamp: string; error: string }> = fs.existsSync(errorLog)
        ? JSON.parse(fs.readFileSync(errorLog, 'utf-8'))
        : [];
      errors.push({ timestamp: new Date().toISOString(), error });
      // Keep last 100 errors
      const trimmed = errors.slice(-100);
      fs.writeFileSync(errorLog, JSON.stringify(trimmed, null, 2));
    } catch { /* best-effort */ }
  }
}

export class MemoryUsageCheck implements HealthCheck {
  name = 'memory';
  intervalSeconds = 120; // 2 minutes
  lastRun?: string;

  check(): HealthCheckResult {
    const now = new Date().toISOString();
    this.lastRun = now;

    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);

    if (rssMB > 2048) {
      return {
        name: this.name,
        status: 'critical',
        message: `Memory usage critical: ${rssMB}MB RSS, ${heapUsedMB}/${heapTotalMB}MB heap`,
        fixAction: {
          description: 'Memory usage is very high — consider restarting the agent',
          tool: 'think',
          args: { thought: `Agent using ${rssMB}MB RSS. May need restart.` },
          risk: 0.5,
        },
        checkedAt: now,
      };
    }

    if (rssMB > 1024) {
      return {
        name: this.name,
        status: 'degraded',
        message: `Memory elevated: ${rssMB}MB RSS, ${heapUsedMB}/${heapTotalMB}MB heap`,
        checkedAt: now,
      };
    }

    return {
      name: this.name,
      status: 'healthy',
      message: `Memory OK: ${rssMB}MB RSS, ${heapUsedMB}/${heapTotalMB}MB heap`,
      checkedAt: now,
    };
  }
}

// ── Self-Monitor Engine ──

export class SelfMonitor {
  private checks: HealthCheck[];
  private history: HealthReport[] = [];
  private maxHistory = 50;

  constructor(projectRoot?: string) {
    this.checks = [
      new BuildHealthCheck(projectRoot),
      new TestHealthCheck(projectRoot),
      new DiskSpaceCheck(),
      new APIHealthCheck(),
      new MemoryUsageCheck(),
    ];
  }

  /** Run all health checks and return a report */
  runAll(): HealthReport {
    const now = new Date();
    const results: HealthCheckResult[] = [];

    for (const check of this.checks) {
      // Respect interval — skip if too recent
      if (check.lastRun && check.intervalSeconds > 0) {
        const elapsed = (now.getTime() - new Date(check.lastRun).getTime()) / 1000;
        if (elapsed < check.intervalSeconds) continue;
      }

      try {
        results.push(check.check());
      } catch (err: unknown) {
        results.push({
          name: check.name,
          status: 'critical',
          message: `Check crashed: ${err instanceof Error ? err.message : String(err)}`,
          checkedAt: now.toISOString(),
        });
      }
    }

    const fixActions = results
      .filter(r => r.fixAction)
      .map(r => r.fixAction!);

    const overall = this.computeOverall(results);

    const report: HealthReport = {
      overall,
      checks: results,
      fixActions,
      timestamp: now.toISOString(),
    };

    this.history.push(report);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    this.persistReport(report);
    return report;
  }

  /** Get the API health check for recording errors */
  getAPICheck(): APIHealthCheck {
    return this.checks.find(c => c.name === 'api') as APIHealthCheck;
  }

  /** Get recent health history */
  getHistory(): HealthReport[] {
    return [...this.history];
  }

  /** Format report for display */
  static formatReport(report: HealthReport): string {
    const icon = report.overall === 'healthy' ? '[OK]' : report.overall === 'degraded' ? '[!!]' : '[XX]';
    const lines = [`${icon} Health: ${report.overall.toUpperCase()}`];

    for (const check of report.checks) {
      const ci = check.status === 'healthy' ? '  +' : check.status === 'degraded' ? '  !' : '  X';
      lines.push(`${ci} ${check.name}: ${check.message}`);
    }

    if (report.fixActions.length > 0) {
      lines.push('', 'Fix actions:');
      for (const action of report.fixActions) {
        lines.push(`  - ${action.description} (tool: ${action.tool}, risk: ${action.risk})`);
      }
    }

    return lines.join('\n');
  }

  /** Record test results for the TestHealthCheck */
  recordTestResult(total: number, failures: number): void {
    try {
      const dir = codebotPath('health');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        codebotPath('health/last-test-result.json'),
        JSON.stringify({ total, failures, timestamp: new Date().toISOString() }, null, 2),
      );
    } catch { /* best effort */ }
  }

  private computeOverall(results: HealthCheckResult[]): HealthStatus {
    if (results.some(r => r.status === 'critical')) return 'critical';
    if (results.some(r => r.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private persistReport(report: HealthReport): void {
    try {
      const dir = codebotPath('health');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        codebotPath('health/latest-report.json'),
        JSON.stringify(report, null, 2),
      );
    } catch { /* best effort */ }
  }
}
