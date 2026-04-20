/**
 * Host-environment grounding block.
 *
 * Sonnet (and other models) default to "I'm in a limited Linux sandbox" when
 * given a Mac filesystem path and asked to run a command. That's a
 * hallucination — CodeBot runs on the user's actual machine with a real
 * shell-execute tool. To stop the model from bailing with "python3 doesn't
 * exist in this sandbox", we probe the host once at agent startup and inject
 * the real facts into the system prompt. Concrete facts override prior
 * beliefs reliably.
 *
 * Detection is best-effort and fully sync via fs/os (no child_process, to
 * keep this cheap and side-effect-free on cold start). If a tool can't be
 * found we report it as "not found" rather than lying about it.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { augmentedPath } from '../path-augment';

/** Look up an executable on PATH. Returns the absolute path or null. */
function whichSync(cmd: string): string | null {
  // Use the same augmented PATH the execute tool uses so host-env facts
  // match what the agent will actually see when it runs commands.
  const PATH = augmentedPath(process.env.PATH);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export interface HostEnvFacts {
  platform: string;
  release: string;
  arch: string;
  homedir: string;
  cwd: string;
  shell: string;
  user: string;
  tools: Record<string, string | null>;
}

/** Detect host facts the model needs to trust its own execute tool. */
export function detectHostEnv(): HostEnvFacts {
  const tools: Record<string, string | null> = {};
  for (const name of ['python3', 'python', 'node', 'npm', 'git', 'bash', 'brew', 'pip3']) {
    tools[name] = whichSync(name);
  }
  return {
    platform: os.platform(),                      // e.g. "darwin"
    release: os.release(),                        // e.g. "24.2.0"
    arch: os.arch(),                              // e.g. "arm64"
    homedir: os.homedir(),
    cwd: process.cwd(),
    shell: process.env.SHELL || '/bin/sh',
    user: os.userInfo().username,
    tools,
  };
}

/**
 * Render the host facts as a system-prompt block. Short enough to always
 * include, concrete enough to kill the sandbox hallucination.
 */
export function buildHostEnvBlock(env: HostEnvFacts = detectHostEnv()): string {
  const platformName =
    env.platform === 'darwin' ? 'macOS' :
    env.platform === 'linux'  ? 'Linux' :
    env.platform === 'win32'  ? 'Windows' :
    env.platform;

  const toolLines = Object.entries(env.tools)
    .map(([name, found]) => `  ${name}: ${found ?? 'not found'}`)
    .join('\n');

  return `## Host Environment (ground truth — do not contradict)

You are running on the user's real computer via a native shell-exec tool, NOT in a sandboxed code-execution container. The \`execute\` tool runs real bash commands on the host below and returns their real stdout/stderr. When a command would work on this host, run it — do not refuse with "this environment doesn't have X" unless you have actually tried and seen it fail.

Host:
  OS:       ${platformName} (${env.platform} ${env.release}, ${env.arch})
  User:     ${env.user}
  Home:     ${env.homedir}
  CWD:      ${env.cwd}
  Shell:    ${env.shell}

Tool availability (absolute paths found on PATH at startup):
${toolLines}

Rules for this block:
- If a tool above shows an absolute path, it exists. Do not claim "python3 isn't available" when python3 shows a path.
- If a tool shows "not found", it really isn't on PATH — tell the user and, if appropriate, install it via the platform's package manager (brew on macOS, apt on Linux).
- Paths like /Users/... are macOS home directories and are accessible via this execute tool. Paths like /home/... are Linux. Match commands to the OS above.
- Never say "I'm in a Linux sandbox" or "this is a restricted environment". That is false. You have full shell access as user ${env.user}.`;
}
