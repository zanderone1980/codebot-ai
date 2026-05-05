/**
 * Docker Sandbox Execution for CodeBot v1.7.0
 *
 * Runs shell commands inside disposable Docker containers for isolation.
 * Features:
 * - Read-only root filesystem
 * - Project directory mounted read-write
 * - No network by default (configurable)
 * - CPU, memory, PID limits
 * - Automatic container cleanup
 * - Graceful fallback to host execution when Docker unavailable
 */

import { execSync, execFileSync } from 'child_process';
import * as path from 'path';

// ── Types ──

export interface SandboxConfig {
  /** Max CPU cores (default: 2) */
  cpus?: number;
  /** Max memory in MB (default: 512) */
  memoryMb?: number;
  /** Max PIDs in container (default: 100) */
  pidsLimit?: number;
  /** Allow network access (default: false) */
  network?: boolean;
  /** Timeout in ms (default: 120000) */
  timeoutMs?: number;
  /** Working directory inside container (default: /workspace) */
  workDir?: string;
  /** Docker image to use (default: node:20-slim) */
  image?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
}

// ── Docker Detection ──

let _dockerAvailable: boolean | null = null;

/** Check if Docker is installed and the daemon is running */
export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;

  // Allow disabling Docker sandbox via env var (CI, testing)
  if (process.env.CODEBOT_NO_DOCKER === '1') {
    _dockerAvailable = false;
    return false;
  }

  try {
    execSync('docker info', {
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }

  return _dockerAvailable;
}

/** Reset the cached Docker availability check (for testing) */
export function resetDockerCheck(): void {
  _dockerAvailable = null;
}

// ── Sandbox Execution ──

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  cpus: 2,
  memoryMb: 512,
  pidsLimit: 100,
  network: false,
  timeoutMs: 120_000,
  workDir: '/workspace',
  image: 'node:20-slim',
};

/**
 * Execute a command inside a Docker sandbox.
 *
 * The project directory is mounted at /workspace (read-write).
 * Root filesystem is read-only. /tmp is tmpfs (100MB).
 * Network is disabled by default.
 *
 * Falls back to host execution if Docker is unavailable.
 */
export function sandboxExec(
  command: string,
  projectDir: string,
  config?: SandboxConfig,
): SandboxResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const resolvedProjectDir = path.resolve(projectDir);

  if (!isDockerAvailable()) {
    return hostFallback(command, resolvedProjectDir, cfg.timeoutMs);
  }

  // Build docker run args as a real array so we can pass them to
  // execFileSync without going through a shell. The previous code did
  // `execSync(dockerArgs.join(' '))` which broke whenever any arg (most
  // commonly the project path) contained a space or any shell metachar.
  // On this machine the path is `/Users/.../ClaudeWork/codebot-ai`, but
  // e.g. `/Users/me/Documents/My Project/...` would silently misparse the
  // `-v` mount and the sandbox would fail or — worse — mount the wrong
  // thing. execFileSync bypasses the shell entirely; no quoting needed.
  const dockerArgs: string[] = [
    'run',
    '--rm',                                 // Cleanup on exit
    '--read-only',                          // Read-only root filesystem
    '--tmpfs', '/tmp:size=100m',            // Writable /tmp
    '--cpus', String(cfg.cpus),             // CPU limit (was `--cpus="2"` — bogus quoted form)
    '--memory', `${cfg.memoryMb}m`,         // Memory limit
    '--pids-limit', String(cfg.pidsLimit),  // PID limit
    '--security-opt', 'no-new-privileges',  // No privilege escalation
    '--cap-drop', 'ALL',                    // Drop all capabilities (was `--cap-drop=ALL`
                                             //   which would have worked via shell, but
                                             //   with execFileSync we pass it as two args
                                             //   so the flag parser sees it cleanly)
  ];

  // Network
  if (!cfg.network) {
    dockerArgs.push('--network', 'none');
  }

  // Mount project directory. The path is passed as ONE string; the shell
  // used to eat this via dockerArgs.join(' '). execFileSync does not.
  dockerArgs.push('-v', `${resolvedProjectDir}:${cfg.workDir}:rw`);

  // Working directory
  dockerArgs.push('-w', cfg.workDir);

  // Image
  dockerArgs.push(cfg.image);

  // Command (via sh -c for shell features)
  dockerArgs.push('sh', '-c', command);

  try {
    const stdout = execFileSync('docker', dockerArgs, {
      timeout: cfg.timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { stdout: stdout || '', stderr: '', exitCode: 0, sandboxed: true };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
      sandboxed: true,
    };
  }
}

/**
 * Fallback: execute on host with existing security measures.
 * Used when Docker is not available.
 */
function hostFallback(command: string, cwd: string, timeoutMs: number): SandboxResult {
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { stdout: stdout || '', stderr: '', exitCode: 0, sandboxed: false };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
      sandboxed: false,
    };
  }
}

/**
 * Build or pull the sandbox Docker image.
 * Call this during `codebot --setup` or first sandbox use.
 */
export function ensureSandboxImage(image?: string): { ready: boolean; error?: string } {
  const img = image || DEFAULT_CONFIG.image;

  if (!isDockerAvailable()) {
    return { ready: false, error: 'Docker is not available' };
  }

  try {
    // Check if image exists locally
    execSync(`docker image inspect ${img}`, {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ready: true };
  } catch {
    // Image not found, try to pull
    try {
      execSync(`docker pull ${img}`, {
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ready: true };
    } catch (pullErr: unknown) {
      const msg = pullErr instanceof Error ? pullErr.message : String(pullErr);
      return { ready: false, error: `Failed to pull ${img}: ${msg}` };
    }
  }
}

/**
 * Get a summary of sandbox configuration for display.
 */
export function getSandboxInfo(): {
  available: boolean;
  image: string;
  defaults: SandboxConfig;
} {
  return {
    available: isDockerAvailable(),
    image: DEFAULT_CONFIG.image,
    defaults: { ...DEFAULT_CONFIG },
  };
}
