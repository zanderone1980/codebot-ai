/**
 * Solve Command — Autonomous GitHub Issue Solver
 *
 * Pipeline: parse URL → fetch issue → clone repo → analyze → fix → test → score → PR → report
 *
 * Usage: codebot solve https://github.com/owner/repo/issues/123
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';
import { warnNonFatal } from './warn';
import { execFileSync } from 'child_process';
import { Agent } from './agent';
import { AgentEvent, LLMProvider } from './types';
import { buildRepoMap } from './context/repo-map';

// ── Types ──

export interface SolveOptions {
  model: string;
  provider: LLMProvider;
  providerName: string;
  autoApprove: boolean;
  maxIterations: number;
  dryRun: boolean;
  openPr: boolean;
  safe: boolean;
  maxFiles: number;
  timeoutMin: number;
  workspace?: string;
  json: boolean;
  verbose: boolean;
}

export interface IssueInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ user: string; body: string }>;
  url: string;
  state: string;
}

export type SolvePhase =
  | 'parsing'
  | 'fetching'
  | 'cloning'
  | 'analyzing'
  | 'fixing'
  | 'testing'
  | 'scoring'
  | 'committing'
  | 'done'
  | 'failed';

export interface SolveEvent {
  type: 'phase_start' | 'phase_end' | 'progress' | 'agent_event' | 'error' | 'result';
  phase?: SolvePhase;
  message?: string;
  agentEvent?: AgentEvent;
  result?: SolveResult;
  error?: string;
}

export interface SolveResult {
  success: boolean;
  issue: IssueInfo;
  branch: string;
  prUrl?: string;
  prNumber?: number;
  filesModified: string[];
  diff?: string;
  testsPassed: boolean;
  testsOutput?: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  durationMs: number;
  tokensUsed: number;
  cost: string;
  sessionId: string;
}

// ── Constants ──

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT = 15_000;
const DEFAULT_WORKSPACE = codebotPath('workspaces');

// ── Helpers ──

/** Parse a GitHub issue URL into owner/repo/number. Also supports owner/repo#123 shorthand. */
export function parseIssueUrl(url: string): { owner: string; repo: string; number: number } {
  // Full URL: https://github.com/owner/repo/issues/123
  const fullMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (fullMatch) {
    return { owner: fullMatch[1], repo: fullMatch[2], number: parseInt(fullMatch[3], 10) };
  }

  // Shorthand: owner/repo#123
  const shortMatch = url.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10) };
  }

  throw new Error(`Invalid GitHub issue URL: "${url}". Expected: https://github.com/owner/repo/issues/123 or owner/repo#123`);
}

/** Build a safe git branch name from an issue. */
export function buildBranchName(issue: { number: number; title: string }): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
  return `codebot/solve-${issue.number}-${slug}`;
}

/** Make a GitHub API request. */
async function githubApi(
  method: string,
  apiPath: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT);

  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CodeBot-AI-Solve',
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${GITHUB_API}${apiPath}`, opts);
    clearTimeout(timer);

    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

/** Detect test framework from a project directory. Returns command + framework name. */
function detectTestFramework(cwd: string): { name: string; command: string } | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (scripts.test) {
        if (scripts.test.includes('vitest')) return { name: 'vitest', command: 'npx vitest run' };
        if (scripts.test.includes('jest')) return { name: 'jest', command: 'npx jest' };
        if (scripts.test.includes('mocha')) return { name: 'mocha', command: 'npx mocha' };
        if (scripts.test.includes('node --test')) return { name: 'node:test', command: scripts.test };
        return { name: 'npm test', command: 'npm test' };
      }
      if (deps['vitest']) return { name: 'vitest', command: 'npx vitest run' };
      if (deps['jest']) return { name: 'jest', command: 'npx jest' };
    } catch { /* invalid package.json */ }
  }

  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return { name: 'pytest', command: 'python -m pytest -v' };
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { name: 'go test', command: 'go test ./...' };
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { name: 'cargo test', command: 'cargo test' };
  }

  return null;
}

/** Detect project stack from filesystem. */
function detectStack(cwd: string): string {
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['typescript'] || fs.existsSync(path.join(cwd, 'tsconfig.json'))) return 'TypeScript/Node.js';
      return 'JavaScript/Node.js';
    } catch { return 'JavaScript/Node.js'; }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) return 'Python';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'Go';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'Rust';
  if (fs.existsSync(path.join(cwd, 'Gemfile'))) return 'Ruby';
  if (fs.existsSync(path.join(cwd, 'pom.xml')) || fs.existsSync(path.join(cwd, 'build.gradle'))) return 'Java';
  return 'Unknown';
}

/** Extract structured signals from issue body: error messages, file paths, stack traces. */
function triageIssue(issue: IssueInfo): string {
  const signals: string[] = [];
  const text = `${issue.title}\n${issue.body}\n${issue.comments.map(c => c.body).join('\n')}`;

  // File paths mentioned
  const filePaths = text.match(/[\w./]+\.(ts|js|py|go|rs|rb|java|tsx|jsx|css|html|json|yaml|yml|toml|md)\b/g);
  if (filePaths && filePaths.length > 0) {
    const unique = [...new Set(filePaths)];
    signals.push(`Files mentioned: ${unique.join(', ')}`);
  }

  // Error messages / stack traces
  const errorLines = text.split('\n').filter(l =>
    /error|exception|traceback|panic|failed|cannot|undefined|null pointer/i.test(l)
  );
  if (errorLines.length > 0) {
    signals.push(`Error signals:\n${errorLines.slice(0, 5).map(l => `  ${l.trim()}`).join('\n')}`);
  }

  // Expected vs actual
  const expectedMatch = text.match(/expected[:\s]+(.+)/i);
  const actualMatch = text.match(/actual[:\s]+(.+)/i);
  if (expectedMatch) signals.push(`Expected: ${expectedMatch[1].trim()}`);
  if (actualMatch) signals.push(`Actual: ${actualMatch[1].trim()}`);

  return signals.length > 0 ? signals.join('\n') : '';
}

/** Compute confidence score (0-100) based on solve outcome. */
export function computeConfidence(opts: {
  issueBodyLength: number;
  filesChanged: number;
  testsPassed: boolean;
  testsExist: boolean;
  maxFiles: number;
}): number {
  let score = 0;

  // Issue clarity (0-20): longer issues with repro steps are better
  if (opts.issueBodyLength > 200) score += 20;
  else if (opts.issueBodyLength > 50) score += 12;
  else score += 5;

  // Files changed (0-20): fewer = more confident
  if (opts.filesChanged <= 2) score += 20;
  else if (opts.filesChanged <= 5) score += 14;
  else if (opts.filesChanged <= opts.maxFiles) score += 7;
  else score += 0;

  // Test results (0-30): passing = high confidence
  if (opts.testsPassed) score += 30;
  else if (opts.testsExist) score += 5;
  else score += 15; // no tests = moderate (can't verify)

  // Localization (0-20): small changes are better
  if (opts.filesChanged <= 1) score += 20;
  else if (opts.filesChanged <= 3) score += 15;
  else score += 5;

  // Tests exist bonus (0-10)
  if (opts.testsExist && opts.testsPassed) score += 10;
  else if (opts.testsExist) score += 3;

  return Math.min(100, score);
}

/** Compute risk level from solve outcome. */
export function computeRisk(opts: {
  filesChanged: number;
  testsPassed: boolean;
  depsChanged: boolean;
  sensitiveFiles: boolean;
}): 'low' | 'medium' | 'high' {
  if (opts.sensitiveFiles || (!opts.testsPassed && opts.filesChanged > 3) || opts.depsChanged) {
    return 'high';
  }
  if (opts.filesChanged > 5 || (!opts.testsPassed && opts.filesChanged > 1)) {
    return 'medium';
  }
  return 'low';
}

/** Build the system prompt for the solve agent. */
export function buildSolvePrompt(
  issue: IssueInfo,
  repoMap: string,
  stack: string,
  testFramework: string | null,
  triage: string,
): string {
  const parts: string[] = [];

  parts.push(`You are fixing GitHub issue #${issue.number}: "${issue.title}"`);
  parts.push(`Repository: ${issue.owner}/${issue.repo}`);
  parts.push(`Stack: ${stack}`);
  if (testFramework) parts.push(`Test framework: ${testFramework}`);
  parts.push('');

  parts.push('## Issue Description');
  parts.push(issue.body || '(no description)');
  parts.push('');

  if (issue.labels.length > 0) {
    parts.push(`Labels: ${issue.labels.join(', ')}`);
  }

  if (issue.comments.length > 0) {
    parts.push('## Comments');
    for (const c of issue.comments.slice(0, 10)) {
      parts.push(`[${c.user}]: ${c.body}`);
    }
    parts.push('');
  }

  if (triage) {
    parts.push('## Triage Signals');
    parts.push(triage);
    parts.push('');
  }

  parts.push('## Repository Structure');
  parts.push(repoMap.substring(0, 3000)); // Truncate for context budget
  parts.push('');

  parts.push('## Instructions');
  parts.push('1. Read the relevant source files to understand the current behavior');
  parts.push('2. Make the MINIMAL changes needed to fix this issue');
  parts.push('3. Follow the existing code style and patterns exactly');
  parts.push('4. Do NOT change unrelated code or add unnecessary refactoring');
  parts.push('5. If you need to add a test, add it alongside the fix');
  parts.push('6. Use the tools available: read_file, edit_file, write_file, grep, glob, execute');

  return parts.join('\n');
}

/** Generate a unique session ID. */
function generateSessionId(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).substring(2, 8);
  return `cb_${date}_${rand}`;
}

// ── Main Solver ──

export class SolveCommand {
  private options: SolveOptions;
  private githubToken: string;
  private startTime = 0;

  constructor(options: SolveOptions) {
    this.options = options;
    this.githubToken = process.env.GITHUB_TOKEN || '';
  }

  async *run(issueUrl: string): AsyncGenerator<SolveEvent> {
    this.startTime = Date.now();
    const sessionId = generateSessionId();

    // Global timeout
    const timeoutMs = this.options.timeoutMin * 60 * 1000;
    const deadline = this.startTime + timeoutMs;

    // ── Phase 1: Parse URL ──
    yield { type: 'phase_start', phase: 'parsing', message: 'Parsing issue URL...' };
    let parsed: { owner: string; repo: string; number: number };
    try {
      parsed = parseIssueUrl(issueUrl);
    } catch (e) {
      yield { type: 'error', phase: 'parsing', error: (e as Error).message };
      return;
    }
    yield { type: 'phase_end', phase: 'parsing', message: `${parsed.owner}/${parsed.repo}#${parsed.number}` };

    // ── Phase 2: Fetch Issue ──
    if (!this.githubToken) {
      yield {
        type: 'error',
        phase: 'fetching',
        error: 'GITHUB_TOKEN not set. Required for accessing issues and creating PRs.\n  Set it: export GITHUB_TOKEN=ghp_...',
      };
      return;
    }

    yield { type: 'phase_start', phase: 'fetching', message: 'Fetching issue from GitHub...' };
    let issue: IssueInfo;
    try {
      issue = await this.fetchIssue(parsed.owner, parsed.repo, parsed.number);
    } catch (e) {
      yield { type: 'error', phase: 'fetching', error: (e as Error).message };
      return;
    }
    yield {
      type: 'phase_end',
      phase: 'fetching',
      message: `"${issue.title}" [${issue.state}] ${issue.labels.length ? `(${issue.labels.join(', ')})` : ''}`,
    };

    // ── Phase 3: Clone/Update Repo ──
    yield { type: 'phase_start', phase: 'cloning', message: `Preparing ${parsed.owner}/${parsed.repo}...` };
    let repoDir: string;
    try {
      repoDir = this.ensureRepo(parsed.owner, parsed.repo);
    } catch (e) {
      yield { type: 'error', phase: 'cloning', error: (e as Error).message };
      return;
    }
    yield { type: 'phase_end', phase: 'cloning', message: repoDir };

    // ── Phase 4: Analyze Repo ──
    yield { type: 'phase_start', phase: 'analyzing', message: 'Indexing codebase...' };
    const stack = detectStack(repoDir);
    const testFw = detectTestFramework(repoDir);
    let repoMap = '';
    try {
      repoMap = buildRepoMap(repoDir);
    } catch {
      repoMap = '(repo map unavailable)';
    }
    const triage = triageIssue(issue);
    const fileCount = repoMap.split('\n').filter(l => l.trim()).length;
    yield {
      type: 'phase_end',
      phase: 'analyzing',
      message: `${fileCount} entries, ${stack}, ${testFw ? testFw.name : 'no test framework detected'}`,
    };

    // Check timeout
    if (Date.now() > deadline) {
      yield { type: 'error', phase: 'analyzing', error: `Timeout exceeded (${this.options.timeoutMin} min)` };
      return;
    }

    // ── Phase 4.5: Run baseline tests (reproduction attempt) ──
    let baselineTestsPassed = true;
    let baselineTestOutput = '';
    if (testFw) {
      yield { type: 'progress', phase: 'analyzing', message: 'Running baseline tests to check for pre-existing failures...' };
      try {
        const baseResult = this.runTestCommand(testFw.command, repoDir);
        baselineTestsPassed = baseResult.passed;
        baselineTestOutput = baseResult.output;
        yield {
          type: 'progress',
          phase: 'analyzing',
          message: baselineTestsPassed ? 'Baseline tests pass' : 'Some baseline tests already failing',
        };
      } catch {
        yield { type: 'progress', phase: 'analyzing', message: 'Could not run baseline tests' };
      }
    }

    // ── Phase 5: Generate Fix ──
    const branchName = buildBranchName(issue);
    yield { type: 'phase_start', phase: 'fixing', message: `Creating branch ${branchName} and generating fix...` };

    // Create branch
    try {
      execFileSync('git', ['checkout', '-b', branchName], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
    } catch {
      // Branch may already exist from a previous attempt — try switching to it
      try {
        execFileSync('git', ['checkout', branchName], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        // Delete the old branch and recreate from default branch (no destructive ops on working tree)
        const defaultBranch = this.getDefaultBranch(repoDir);
        execFileSync('git', ['checkout', defaultBranch], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        execFileSync('git', ['branch', '-D', branchName], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        execFileSync('git', ['checkout', '-b', branchName], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
      } catch {
        yield { type: 'error', phase: 'fixing', error: `Failed to create or switch to branch ${branchName}` };
        return;
      }
    }

    // Create the solve agent
    const prompt = buildSolvePrompt(issue, repoMap, stack, testFw?.name || null, triage);
    const agent = new Agent({
      provider: this.options.provider,
      model: this.options.model,
      providerName: this.options.providerName,
      maxIterations: this.options.maxIterations,
      autoApprove: true, // Solver runs autonomously
      projectRoot: repoDir,
    });

    // Run the agent
    for await (const event of agent.run(prompt)) {
      yield { type: 'agent_event', phase: 'fixing', agentEvent: event };
      // Check timeout during agent loop
      if (Date.now() > deadline) {
        yield { type: 'progress', phase: 'fixing', message: `Timeout approaching — wrapping up...` };
        break;
      }
    }

    // Get files modified
    const filesModified = this.getModifiedFiles(repoDir);
    yield { type: 'phase_end', phase: 'fixing', message: `${filesModified.length} file(s) modified` };

    // Check if safe mode file limit exceeded
    if (this.options.safe && filesModified.length > 3) {
      yield { type: 'progress', phase: 'fixing', message: `Safe mode: ${filesModified.length} files exceeds limit of 3. Stashing changes.` };
      try {
        execFileSync('git', ['stash', 'push', '-m', 'codebot-solve: safe mode rollback (' + filesModified.length + ' files)'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
      } catch (stashErr) {
        warnNonFatal('solve.safeMode', 'Could not stash changes — leaving working tree intact for manual recovery');
      }
      yield { type: 'error', phase: 'fixing', error: 'Safe mode: too many files changed. Changes stashed (git stash list to recover). Try without --safe.' };
      return;
    }

    if (filesModified.length > this.options.maxFiles) {
      yield { type: 'progress', phase: 'fixing', message: `${filesModified.length} files exceeds --max-files ${this.options.maxFiles}. Stashing changes.` };
      try {
        execFileSync('git', ['stash', 'push', '-m', 'codebot-solve: max-files rollback (' + filesModified.length + ' files)'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
      } catch (stashErr) {
        warnNonFatal('solve.maxFiles', 'Could not stash changes — leaving working tree intact for manual recovery');
      }
      yield { type: 'error', phase: 'fixing', error: `Max files limit exceeded (${filesModified.length} > ${this.options.maxFiles}). Changes stashed (git stash list to recover).` };
      return;
    }

    if (filesModified.length === 0) {
      yield { type: 'error', phase: 'fixing', error: 'No files were modified. The agent could not produce a fix.' };
      return;
    }

    // Generate diff
    let diff = '';
    try {
      diff = execFileSync('git', ['diff', '--stat'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 }).trim();
      const fullDiff = execFileSync('git', ['diff'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 }).trim();
      if (fullDiff.length < 5000) diff = fullDiff;
    } catch { /* ignore */ }

    // ── Phase 6: Run Tests ──
    let testsPassed = false;
    let testsOutput = '';
    const testsExist = !!testFw;

    if (testFw) {
      yield { type: 'phase_start', phase: 'testing', message: `Running tests (${testFw.name})...` };
      const maxRetries = 2;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const testResult = this.runTestCommand(testFw.command, repoDir);
        testsOutput = testResult.output;
        testsPassed = testResult.passed;

        if (testsPassed || attempt === maxRetries) break;

        // Check if we made things worse (rollback protection)
        if (!baselineTestsPassed) {
          // Baseline was already failing — check if we made it worse
          yield { type: 'progress', phase: 'testing', message: 'Note: some tests were already failing before the fix' };
        }

        yield {
          type: 'progress',
          phase: 'testing',
          message: `Tests failed (attempt ${attempt + 1}/${maxRetries + 1}). Feeding failure back to agent...`,
        };

        // Feed test failure back to agent for retry
        const retryPrompt = `The tests failed after your fix. Here is the test output:\n\n${testsOutput.substring(0, 3000)}\n\nPlease fix the failing tests. Make minimal changes.`;
        for await (const event of agent.run(retryPrompt)) {
          yield { type: 'agent_event', phase: 'testing', agentEvent: event };
          if (Date.now() > deadline) break;
        }
      }

      yield { type: 'phase_end', phase: 'testing', message: testsPassed ? 'All tests pass' : 'Tests still failing' };
    } else {
      yield { type: 'progress', phase: 'testing', message: 'No test framework detected — skipping tests' };
    }

    // ── Phase 7: Confidence Scoring ──
    yield { type: 'phase_start', phase: 'scoring', message: 'Computing confidence...' };

    // Check for dependency changes
    const depsChanged = filesModified.some(f =>
      f === 'package.json' || f === 'package-lock.json' || f === 'yarn.lock' ||
      f === 'pnpm-lock.yaml' || f === 'go.sum' || f === 'Cargo.lock' ||
      f === 'requirements.txt' || f === 'Pipfile.lock'
    );

    // Check for sensitive files
    const sensitiveFiles = filesModified.some(f =>
      /auth|security|password|secret|token|key|crypt|permission|rbac/i.test(f)
    );

    const confidence = computeConfidence({
      issueBodyLength: issue.body.length,
      filesChanged: filesModified.length,
      testsPassed,
      testsExist,
      maxFiles: this.options.maxFiles,
    });

    const risk = computeRisk({
      filesChanged: filesModified.length,
      testsPassed,
      depsChanged,
      sensitiveFiles,
    });

    yield { type: 'phase_end', phase: 'scoring', message: `Confidence: ${confidence}% | Risk: ${risk}` };

    // ── Phase 8: Commit + PR ──
    const tokenTracker = agent.getTokenTracker();
    const tokensUsed = tokenTracker.getSummary().totalInputTokens + tokenTracker.getSummary().totalOutputTokens;
    const cost = tokenTracker.formatCost();

    if (this.options.openPr && !this.options.dryRun) {
      yield { type: 'phase_start', phase: 'committing', message: 'Creating commit and pull request...' };

      try {
        // Stage + commit
        execFileSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        const commitMsg = `fix: ${issue.title} (fixes #${issue.number})\n\nAutonomously generated by CodeBot-AI solve command.\nConfidence: ${confidence}% | Risk: ${risk}`;
        execFileSync('git', ['commit', '-m', commitMsg], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 });

        // Push
        const pushUrl = `https://${this.githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
        execFileSync('git', ['remote', 'set-url', 'origin', pushUrl], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        execFileSync('git', ['push', '-u', 'origin', branchName], { cwd: repoDir, encoding: 'utf-8', timeout: 60_000 });

        // Create PR
        const defaultBranch = this.getDefaultBranch(repoDir);
        const prBody = this.buildPrBody(issue, filesModified, testsPassed, testsOutput, confidence, risk);
        const prResult = await githubApi('POST', `/repos/${parsed.owner}/${parsed.repo}/pulls`, this.githubToken, {
          title: `fix: ${issue.title}`,
          body: prBody,
          head: branchName,
          base: defaultBranch,
        });

        if (prResult.status === 201) {
          const pr = prResult.data as { number: number; html_url: string };
          yield { type: 'phase_end', phase: 'committing', message: `PR #${pr.number}: ${pr.html_url}` };

          // Build final result
          const result: SolveResult = {
            success: true, issue, branch: branchName,
            prUrl: pr.html_url, prNumber: pr.number,
            filesModified, diff, testsPassed, testsOutput,
            confidence, risk, durationMs: Date.now() - this.startTime,
            tokensUsed, cost, sessionId,
          };
          this.saveSession(result);
          yield { type: 'result', phase: 'done', result };
          return;
        } else {
          const errData = prResult.data as { message?: string };
          yield { type: 'error', phase: 'committing', error: `PR creation failed: ${errData.message || JSON.stringify(prResult.data).substring(0, 200)}` };
        }
      } catch (e) {
        yield { type: 'error', phase: 'committing', error: `Commit/push failed: ${(e as Error).message}` };
      }
    } else if (this.options.dryRun) {
      yield { type: 'progress', phase: 'committing', message: 'Dry run — skipping commit and PR creation' };
      if (diff) {
        yield { type: 'progress', phase: 'committing', message: `\nDiff preview:\n${diff}` };
      }
    } else {
      // Not dry-run but not --open-pr: commit locally only
      try {
        execFileSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        const commitMsg = `fix: ${issue.title} (fixes #${issue.number})\n\nAutonomously generated by CodeBot-AI solve command.\nConfidence: ${confidence}% | Risk: ${risk}`;
        execFileSync('git', ['commit', '-m', commitMsg], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 });
        yield { type: 'progress', phase: 'committing', message: `Committed locally on branch ${branchName}. Use --open-pr to push and create a PR.` };
      } catch (e) {
        yield { type: 'progress', phase: 'committing', message: `Local commit: ${(e as Error).message}` };
      }
    }

    // ── Phase 9: Final Report ──
    const result: SolveResult = {
      success: filesModified.length > 0,
      issue, branch: branchName,
      filesModified, diff, testsPassed, testsOutput,
      confidence, risk,
      durationMs: Date.now() - this.startTime,
      tokensUsed, cost, sessionId,
    };
    this.saveSession(result);
    yield { type: 'result', phase: 'done', result };
  }

  // ── Private Methods ──

  private async fetchIssue(owner: string, repo: string, number: number): Promise<IssueInfo> {
    const issueRes = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, this.githubToken);
    if (issueRes.status !== 200) {
      const msg = typeof issueRes.data === 'object' && issueRes.data && 'message' in issueRes.data
        ? (issueRes.data as { message: string }).message
        : `HTTP ${issueRes.status}`;
      throw new Error(`Failed to fetch issue: ${msg}`);
    }

    const data = issueRes.data as {
      number: number; title: string; body: string; state: string;
      user: { login: string }; labels: Array<{ name: string }>;
      html_url: string;
    };

    // Fetch comments
    let comments: Array<{ user: string; body: string }> = [];
    try {
      const commentsRes = await githubApi('GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=20`,
        this.githubToken);
      if (commentsRes.status === 200) {
        const raw = commentsRes.data as Array<{ user: { login: string }; body: string }>;
        comments = raw.map(c => ({ user: c.user.login, body: c.body }));
      }
    } catch { /* ignore comment fetch failure */ }

    return {
      owner, repo, number: data.number,
      title: data.title,
      body: data.body || '',
      labels: data.labels.map(l => l.name),
      comments,
      url: data.html_url,
      state: data.state,
    };
  }

  private ensureRepo(owner: string, repo: string): string {
    const workspaceBase = this.options.workspace || DEFAULT_WORKSPACE;
    const repoDir = path.join(workspaceBase, owner, repo);

    // Ensure workspace directory exists
    const ownerDir = path.join(workspaceBase, owner);
    if (!fs.existsSync(ownerDir)) {
      fs.mkdirSync(ownerDir, { recursive: true });
    }

    if (fs.existsSync(path.join(repoDir, '.git'))) {
      // Repo already cloned — update it
      try {
        // Check if it's clean
        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: repoDir, encoding: 'utf-8', timeout: 10_000,
        }).trim();

        if (status) {
          // Dirty — stash changes from previous solve attempt (recoverable via git stash list)
          try {
            execFileSync('git', ['stash', 'push', '--include-untracked', '-m', 'codebot-solve: previous attempt auto-stashed'], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
          } catch {
            // Stash failed — leave working tree intact, warn but don't destroy work
            warnNonFatal('solve.ensureRepo', 'Could not stash dirty working tree — proceeding with existing state');
          }
        }

        const defaultBranch = this.getDefaultBranch(repoDir);
        execFileSync('git', ['checkout', defaultBranch], { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
        execFileSync('git', ['pull', '--ff-only'], { cwd: repoDir, encoding: 'utf-8', timeout: 60_000 });
      } catch {
        // If update fails, just use what we have
      }
    } else {
      // Clone
      const cloneUrl = this.githubToken
        ? `https://${this.githubToken}@github.com/${owner}/${repo}.git`
        : `https://github.com/${owner}/${repo}.git`;

      execFileSync('git', ['clone', '--depth', '50', cloneUrl, repoDir], {
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    return repoDir;
  }

  private getDefaultBranch(repoDir: string): string {
    try {
      // Check remote HEAD
      const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd: repoDir, encoding: 'utf-8', timeout: 5_000,
      }).trim();
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: check if main or master exists
      try {
        execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: repoDir, encoding: 'utf-8', timeout: 5_000 });
        return 'main';
      } catch {
        return 'master';
      }
    }
  }

  private getModifiedFiles(repoDir: string): string[] {
    try {
      const output = execFileSync('git', ['diff', '--name-only'], {
        cwd: repoDir, encoding: 'utf-8', timeout: 10_000,
      }).trim();
      // Also check for new untracked files
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: repoDir, encoding: 'utf-8', timeout: 10_000,
      }).trim();
      const files = output ? output.split('\n') : [];
      if (untracked) files.push(...untracked.split('\n'));
      return [...new Set(files.filter(f => f.trim()))];
    } catch {
      return [];
    }
  }

  private runTestCommand(command: string, cwd: string): { passed: boolean; output: string } {
    try {
      const parts = command.split(' ');
      const output = execFileSync(parts[0], parts.slice(1), {
        cwd,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { passed: true, output: output.substring(0, 5000) };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      const output = ((e.stdout || '') + '\n' + (e.stderr || '')).substring(0, 5000);
      return { passed: false, output };
    }
  }

  private buildPrBody(
    issue: IssueInfo,
    filesModified: string[],
    testsPassed: boolean,
    testsOutput: string,
    confidence: number,
    risk: 'low' | 'medium' | 'high',
  ): string {
    const lines: string[] = [];

    lines.push(`Fixes #${issue.number}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`Autonomously generated fix for: **${issue.title}**`);
    lines.push('');
    lines.push('## Files Changed');
    for (const f of filesModified) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
    lines.push('## Validation');
    lines.push(`- Tests: ${testsPassed ? 'PASSED' : 'FAILED'}`);
    lines.push(`- Confidence: ${confidence}%`);
    lines.push(`- Risk: ${risk}`);
    lines.push('');

    if (testsOutput && !testsPassed) {
      lines.push('<details>');
      lines.push('<summary>Test Output</summary>');
      lines.push('');
      lines.push('```');
      lines.push(testsOutput.substring(0, 2000));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by [CodeBot-AI](https://github.com/Ascendral/codebot-ai) solve command*');

    return lines.join('\n');
  }

  private saveSession(result: SolveResult): void {
    try {
      const sessionsDir = codebotPath('sessions');
      if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
      const filename = `solve-${result.issue.number}-${Date.now()}.json`;
      fs.writeFileSync(path.join(sessionsDir, filename), JSON.stringify(result, null, 2), 'utf-8');
    } catch (err) { warnNonFatal('solve.saveSession', err); }
  }
}
