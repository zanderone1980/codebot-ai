import * as readline from 'readline';
import type { RiskAssessment } from '../risk';

/** Permission callback type — risk and sandbox info are optional for backwards compat */
export type AskPermissionFn = (
  tool: string,
  args: Record<string, unknown>,
  risk?: RiskAssessment,
  sandbox?: { sandbox: boolean; network: boolean },
) => Promise<boolean>;

const PERMISSION_TIMEOUT_MS = 30_000;

/** Default CLI permission prompt. Reads y/N from stdin with a 30-second timeout. */
export async function defaultAskPermission(tool: string, args: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const summary = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join('\n');

  let timerId: ReturnType<typeof setTimeout> | undefined;

  const userResponse = new Promise<boolean>((resolve) => {
    rl.question(`\n⚡ ${tool}\n${summary}\nAllow? [y/N] (${PERMISSION_TIMEOUT_MS / 1000}s timeout) `, (answer) => {
      if (timerId) clearTimeout(timerId);
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });

  const timeout = new Promise<boolean>((resolve) => {
    timerId = setTimeout(() => {
      rl.close();
      process.stdout.write('\n⏱ Permission timed out — denied by default.\n');
      resolve(false);
    }, PERMISSION_TIMEOUT_MS);
  });

  return Promise.race([userResponse, timeout]);
}
