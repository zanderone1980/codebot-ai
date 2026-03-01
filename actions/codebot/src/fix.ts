import * as core from '@actions/core';
import * as github from '@actions/github';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Agent, AgentEvent } from 'codebot-ai';
import { fixPrompt } from './prompts';

const execAsync = promisify(exec);

/**
 * Context required for the auto-fix task.
 */
export interface FixContext {
  /** GitHub token for API access. */
  token: string;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** The current branch ref. */
  ref: string;
  /** The SHA of the current commit. */
  sha: string;
}

/**
 * Extract the fix context from the GitHub Action environment.
 *
 * @returns The fix context with owner, repo, ref, and SHA.
 */
export function getFixContext(): FixContext {
  const token = process.env.GITHUB_TOKEN || core.getInput('api-key');
  const { owner, repo } = github.context.repo;
  const ref = github.context.ref;
  const sha = github.context.sha;

  return { token, owner, repo, ref, sha };
}

/**
 * Read CI failure logs from the GitHub Actions environment.
 *
 * Attempts to read failure context from the workflow run. Falls back to
 * environment variables and step outputs if the API is unavailable.
 *
 * @param context - The fix context containing repo details.
 * @returns The error log content from the failed CI run.
 */
async function getCIFailureLog(context: FixContext): Promise<string> {
  const octokit = github.getOctokit(context.token);

  try {
    // Try to get the workflow run's failed jobs
    const runId = parseInt(process.env.GITHUB_RUN_ID || '0', 10);
    if (runId > 0) {
      const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: context.owner,
        repo: context.repo,
        run_id: runId,
        filter: 'latest',
      });

      const failedJobs = jobs.jobs.filter(
        (job) => job.conclusion === 'failure'
      );

      if (failedJobs.length > 0) {
        const logParts: string[] = [];
        for (const job of failedJobs) {
          const failedSteps = (job.steps || []).filter(
            (step) => step.conclusion === 'failure'
          );
          for (const step of failedSteps) {
            logParts.push(
              `Job: ${job.name}\nStep: ${step.name}\nStatus: ${step.conclusion}\n`
            );
          }
          // Attempt to get the full job log
          try {
            const { data: log } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner: context.owner,
              repo: context.repo,
              job_id: job.id,
            });
            logParts.push(log as unknown as string);
          } catch {
            core.debug(`Could not download logs for job ${job.id}`);
          }
        }

        if (logParts.length > 0) {
          return logParts.join('\n---\n');
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to fetch CI logs via API: ${error}`);
  }

  // Fallback: check for error output in environment
  const errorOutput = process.env.CI_ERROR_LOG || process.env.BUILD_ERROR || '';
  if (errorOutput.length > 0) {
    return errorOutput;
  }

  return 'No detailed CI failure logs available. Please examine the recent test and build output in this repository to identify and fix failures.';
}

/**
 * Run the auto-fix task: analyze CI failures and apply fixes.
 *
 * The agent reads the CI error log, identifies the root cause, modifies
 * source files using its tools, then the action commits and pushes the changes.
 *
 * @param agent - The CodeBot AI agent instance.
 * @param context - The fix context containing repo and ref details.
 */
export async function autoFix(agent: Agent, context: FixContext): Promise<void> {
  // Get CI failure logs
  core.info('Fetching CI failure logs...');
  const errorLog = await getCIFailureLog(context);

  // Run the agent with the fix prompt -- agent will use tools to modify files
  core.info('Running AI auto-fix...');
  const prompt = fixPrompt(errorLog);

  const events: AsyncGenerator<AgentEvent> = agent.run(prompt);
  for await (const event of events) {
    if (event.type === 'text' && typeof event.content === 'string') {
      core.info(`Agent: ${event.content.substring(0, 200)}`);
    }
    if (event.type === 'tool_use') {
      core.info(`Agent using tool: ${event.name}`);
    }
    if (event.type === 'error') {
      core.warning(`Agent error: ${event.content}`);
    }
  }

  // Check if the agent made any file changes
  core.info('Checking for file changes...');
  const { stdout: statusOutput } = await execAsync('git status --porcelain', {
    cwd: process.cwd(),
  });

  if (statusOutput.trim().length === 0) {
    core.info('No file changes were made by the agent. Nothing to commit.');
    return;
  }

  core.info('Agent made the following changes:');
  core.info(statusOutput);

  // Configure git for the commit
  await execAsync(
    'git config user.name "CodeBot AI" && git config user.email "codebot-ai[bot]@users.noreply.github.com"',
    { cwd: process.cwd() }
  );

  // Stage, commit, and push changes
  await execAsync('git add -A', { cwd: process.cwd() });
  await execAsync('git commit -m "fix: auto-fix CI failures [codebot-ai]"', {
    cwd: process.cwd(),
  });

  // Extract branch name from ref
  const branch = context.ref.replace('refs/heads/', '');
  core.info(`Pushing changes to branch: ${branch}`);

  await execAsync(`git push origin HEAD:${branch}`, {
    cwd: process.cwd(),
  });

  core.info('Auto-fix changes committed and pushed successfully.');
}
