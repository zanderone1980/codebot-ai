/**
 * CodeBot AI — Environment Health Check (v2.3.0)
 *
 * Validates Node.js version, config, sessions, audit integrity,
 * LLM connectivity, API keys, git, Docker, and disk space.
 *
 * NEVER throws — all checks are fail-safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { AuditLogger } from './audit';
import { box, UI } from './ui';

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

export interface DoctorReport {
  checks: HealthCheck[];
  passed: number;
  warned: number;
  failed: number;
}

const CODEBOT_DIR = path.join(os.homedir(), '.codebot');

function check(name: string, fn: () => HealthCheck): HealthCheck {
  try {
    return fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `Check threw: ${msg}` };
  }
}

function checkNodeVersion(): HealthCheck {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 18) {
    return { name: 'nodeVersion', status: 'pass', message: `Node.js ${version}` };
  }
  return { name: 'nodeVersion', status: 'fail', message: `Node.js ${version} — v18+ required` };
}

function checkNpmVersion(): HealthCheck {
  try {
    const version = execSync('npm --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    return { name: 'npmVersion', status: 'pass', message: `npm ${version}` };
  } catch {
    return { name: 'npmVersion', status: 'warn', message: 'npm not found in PATH' };
  }
}

function checkConfigExists(): HealthCheck {
  const configPath = path.join(CODEBOT_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { name: 'configExists', status: 'pass', message: 'config.json found and valid' };
    } catch {
      return { name: 'configExists', status: 'warn', message: 'config.json exists but is malformed' };
    }
  }
  return { name: 'configExists', status: 'warn', message: 'No config.json — run codebot --setup' };
}

function checkSessionsDir(): HealthCheck {
  const dir = path.join(CODEBOT_DIR, 'sessions');
  if (!fs.existsSync(dir)) {
    return { name: 'sessionsDir', status: 'warn', message: 'Sessions directory does not exist yet' };
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    return { name: 'sessionsDir', status: 'pass', message: `${files.length} session(s) stored` };
  } catch {
    return { name: 'sessionsDir', status: 'fail', message: 'Sessions directory not readable/writable' };
  }
}

function checkAuditDir(): HealthCheck {
  const dir = path.join(CODEBOT_DIR, 'audit');
  if (!fs.existsSync(dir)) {
    return { name: 'auditDir', status: 'warn', message: 'Audit directory does not exist yet' };
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    return { name: 'auditDir', status: 'pass', message: `${files.length} audit log(s)` };
  } catch {
    return { name: 'auditDir', status: 'fail', message: 'Audit directory not readable/writable' };
  }
}

function checkAuditIntegrity(): HealthCheck {
  try {
    const logger = new AuditLogger();
    const entries = logger.query();
    if (entries.length === 0) {
      return { name: 'auditIntegrity', status: 'pass', message: 'No audit entries to verify' };
    }
    // Group by session and verify each
    const sessions = new Map<string, typeof entries>();
    for (const e of entries) {
      if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, []);
      sessions.get(e.sessionId)!.push(e);
    }
    let invalidCount = 0;
    for (const [, sessionEntries] of sessions) {
      const result = AuditLogger.verify(sessionEntries);
      if (!result.valid) invalidCount++;
    }
    if (invalidCount === 0) {
      return { name: 'auditIntegrity', status: 'pass', message: `${sessions.size} session chain(s) verified` };
    }
    return { name: 'auditIntegrity', status: 'warn', message: `${invalidCount}/${sessions.size} chain(s) invalid` };
  } catch {
    return { name: 'auditIntegrity', status: 'warn', message: 'Could not verify audit chains' };
  }
}

function checkDiskSpace(): HealthCheck {
  try {
    const stats = fs.statfsSync(CODEBOT_DIR);
    const freeBytes = stats.bavail * stats.bsize;
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    if (freeMB > 500) {
      return { name: 'diskSpace', status: 'pass', message: `${freeMB} MB free` };
    }
    if (freeMB > 100) {
      return { name: 'diskSpace', status: 'warn', message: `${freeMB} MB free — getting low` };
    }
    return { name: 'diskSpace', status: 'fail', message: `${freeMB} MB free — critically low` };
  } catch {
    return { name: 'diskSpace', status: 'warn', message: 'Could not check disk space' };
  }
}

function checkLocalLlm(): HealthCheck {
  const endpoints = [
    { url: 'http://localhost:11434/v1/models', name: 'Ollama' },
    { url: 'http://localhost:1234/v1/models', name: 'LM Studio' },
  ];
  const found: string[] = [];
  for (const ep of endpoints) {
    try {
      // Use sync HTTP check via curl (fastest reliable method)
      execSync(`curl -s --max-time 2 ${ep.url}`, { encoding: 'utf-8', timeout: 3000 });
      found.push(ep.name);
    } catch {
      // Not running
    }
  }
  if (found.length > 0) {
    return { name: 'localLlm', status: 'pass', message: `Found: ${found.join(', ')}` };
  }
  return { name: 'localLlm', status: 'warn', message: 'No local LLM detected (Ollama/LM Studio)' };
}

function checkCloudApiKeys(): HealthCheck {
  const keys: Record<string, string> = {
    ANTHROPIC_API_KEY: 'Anthropic',
    OPENAI_API_KEY: 'OpenAI',
    GEMINI_API_KEY: 'Gemini',
    DEEPSEEK_API_KEY: 'DeepSeek',
    GROQ_API_KEY: 'Groq',
    MISTRAL_API_KEY: 'Mistral',
    XAI_API_KEY: 'xAI',
  };
  const present: string[] = [];
  for (const [envVar, label] of Object.entries(keys)) {
    if (process.env[envVar]) present.push(label);
  }
  if (present.length > 0) {
    return { name: 'cloudApiKeys', status: 'pass', message: `Keys set: ${present.join(', ')}` };
  }
  return { name: 'cloudApiKeys', status: 'warn', message: 'No cloud API keys in environment' };
}

function checkEncryptionKey(): HealthCheck {
  if (process.env.CODEBOT_ENCRYPTION_KEY) {
    return { name: 'encryptionKey', status: 'pass', message: 'Encryption at rest enabled' };
  }
  return { name: 'encryptionKey', status: 'warn', message: 'No encryption key set (CODEBOT_ENCRYPTION_KEY)', detail: 'Sessions and audit logs stored in plaintext' };
}

function checkGitAvailable(): HealthCheck {
  try {
    const version = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    return { name: 'gitAvailable', status: 'pass', message: version };
  } catch {
    return { name: 'gitAvailable', status: 'warn', message: 'git not found in PATH' };
  }
}

function checkDockerAvailable(): HealthCheck {
  try {
    execSync('docker info', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return { name: 'dockerAvailable', status: 'pass', message: 'Docker available' };
  } catch {
    return { name: 'dockerAvailable', status: 'warn', message: 'Docker not available (sandbox mode limited)' };
  }
}

/** Run all health checks and return a report. Never throws. */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: HealthCheck[] = [
    check('nodeVersion', checkNodeVersion),
    check('npmVersion', checkNpmVersion),
    check('configExists', checkConfigExists),
    check('sessionsDir', checkSessionsDir),
    check('auditDir', checkAuditDir),
    check('auditIntegrity', checkAuditIntegrity),
    check('diskSpace', checkDiskSpace),
    check('localLlm', checkLocalLlm),
    check('cloudApiKeys', checkCloudApiKeys),
    check('encryptionKey', checkEncryptionKey),
    check('gitAvailable', checkGitAvailable),
    check('dockerAvailable', checkDockerAvailable),
  ];

  const passed = checks.filter(c => c.status === 'pass').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  return { checks, passed, warned, failed };
}

/** Format the doctor report for terminal display. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  for (const c of report.checks) {
    let icon: string;
    if (c.status === 'pass') {
      icon = `${UI.brightGreen}\u2713${UI.reset}`;
    } else if (c.status === 'warn') {
      icon = `${UI.yellow}\u26a0${UI.reset}`;
    } else {
      icon = `${UI.red}\u2717${UI.reset}`;
    }
    lines.push(`${icon} ${c.message}`);
    if (c.detail) {
      lines.push(`  ${UI.dim}${c.detail}${UI.reset}`);
    }
  }

  lines.push('');
  lines.push(`${UI.bold}${report.passed} passed${UI.reset}, ${report.warned > 0 ? UI.yellow : ''}${report.warned} warnings${UI.reset}, ${report.failed > 0 ? UI.red : ''}${report.failed} failed${UI.reset}`);

  return box('CodeBot Doctor', lines);
}
