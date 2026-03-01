import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Agent, AgentEvent } from 'codebot-ai';
import { reviewPrompt } from './prompts';

/**
 * Context required for the review task, derived from the GitHub Action environment.
 */
export interface ReviewContext {
  /** GitHub token for API access. */
  token: string;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number. */
  pullNumber: number;
}

/**
 * Extract the review context from the GitHub Action environment.
 *
 * @returns The review context with owner, repo, and pull number.
 * @throws If the action is not running in a pull request context.
 */
export function getReviewContext(): ReviewContext {
  const token = process.env.GITHUB_TOKEN || core.getInput('api-key');
  const { owner, repo } = github.context.repo;
  const pullNumber = github.context.payload.pull_request?.number;

  if (!pullNumber) {
    throw new Error(
      'CodeBot review task requires a pull_request event context. ' +
      'Ensure this action is triggered by a pull_request event.'
    );
  }

  return { token, owner, repo, pullNumber };
}

/**
 * Run an AI-powered code review on a pull request.
 *
 * Fetches the PR diff from GitHub, passes it to the agent for review,
 * collects the agent's text output, and posts it as a PR review comment.
 *
 * @param agent - The CodeBot AI agent instance.
 * @param context - The review context containing repo and PR details.
 */
export async function reviewPR(agent: Agent, context: ReviewContext): Promise<void> {
  const octokit = github.getOctokit(context.token);

  // Fetch the pull request diff
  core.info(`Fetching diff for PR #${context.pullNumber}...`);
  const { data: diff } = await octokit.rest.pulls.get({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    mediaType: { format: 'diff' },
  });

  // The diff comes back as a string when using the diff media type
  const diffContent = diff as unknown as string;

  if (!diffContent || diffContent.trim().length === 0) {
    core.info('Pull request has no diff content. Skipping review.');
    return;
  }

  // Run the agent with the review prompt
  core.info('Running AI review...');
  const prompt = reviewPrompt(diffContent);
  const outputParts: string[] = [];

  const events: AsyncGenerator<AgentEvent> = agent.run(prompt);
  for await (const event of events) {
    if (event.type === 'text' && typeof event.content === 'string') {
      outputParts.push(event.content);
    }
    if (event.type === 'error') {
      core.warning(`Agent encountered an error during review: ${event.content}`);
    }
  }

  const reviewBody = outputParts.join('');

  if (reviewBody.trim().length === 0) {
    core.warning('Agent produced no review output.');
    return;
  }

  // Post the review as a PR comment
  core.info('Posting review comment...');
  await octokit.rest.pulls.createReview({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    body: `## CodeBot AI Review\n\n${reviewBody}`,
    event: 'COMMENT',
  });

  core.info(`Review posted successfully on PR #${context.pullNumber}.`);
}
