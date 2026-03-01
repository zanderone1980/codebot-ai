import * as core from '@actions/core';
import {
  Agent,
  AnthropicProvider,
  OpenAIProvider,
  PROVIDER_DEFAULTS,
} from 'codebot-ai';
import type { LLMProvider } from 'codebot-ai';
import { reviewPR, getReviewContext } from './review';
import { autoFix, getFixContext } from './fix';
import { securityScan } from './scan';

/**
 * Supported task types for the CodeBot AI action.
 */
type Task = 'review' | 'fix' | 'scan';

/**
 * Supported provider names.
 */
type ProviderName = 'anthropic' | 'openai';

/**
 * Create an LLM provider instance based on the provider name and API key.
 *
 * @param providerName - The name of the provider: 'anthropic' or 'openai'.
 * @param apiKey - The API key for the provider.
 * @returns An LLMProvider instance.
 */
function createProvider(providerName: ProviderName, apiKey: string): LLMProvider {
  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey });
    case 'openai':
      return new OpenAIProvider({ apiKey });
    default:
      throw new Error(
        `Unsupported provider: "${providerName}". Use "anthropic" or "openai".`
      );
  }
}

/**
 * Validate and return the task input.
 *
 * @param taskInput - The raw task string from the action input.
 * @returns The validated task.
 */
function validateTask(taskInput: string): Task {
  const normalized = taskInput.trim().toLowerCase();
  if (normalized !== 'review' && normalized !== 'fix' && normalized !== 'scan') {
    throw new Error(
      `Invalid task: "${taskInput}". Supported tasks are: review, fix, scan.`
    );
  }
  return normalized;
}

/**
 * Validate and return the provider input.
 *
 * @param providerInput - The raw provider string from the action input.
 * @returns The validated provider name.
 */
function validateProvider(providerInput: string): ProviderName {
  const normalized = providerInput.trim().toLowerCase();
  if (normalized !== 'anthropic' && normalized !== 'openai') {
    throw new Error(
      `Invalid provider: "${providerInput}". Supported providers are: anthropic, openai.`
    );
  }
  return normalized;
}

/**
 * Main entry point for the CodeBot AI GitHub Action.
 *
 * Parses inputs, creates the AI agent, and dispatches to the appropriate
 * task handler based on the 'task' input.
 */
async function run(): Promise<void> {
  try {
    // Parse action inputs
    const task = validateTask(core.getInput('task', { required: true }));
    const model = core.getInput('model') || 'claude-sonnet-4-20250514';
    const providerName = validateProvider(core.getInput('provider') || 'anthropic');
    const apiKey = core.getInput('api-key', { required: true });
    const maxIterations = parseInt(core.getInput('max-iterations') || '25', 10);

    core.info(`CodeBot AI starting...`);
    core.info(`Task: ${task}`);
    core.info(`Provider: ${providerName}`);
    core.info(`Model: ${model}`);
    core.info(`Max iterations: ${maxIterations}`);

    // Create the LLM provider
    const provider = createProvider(providerName, apiKey);

    // Create the agent
    const agent = new Agent({
      provider,
      model,
      providerName,
      maxIterations,
      autoApprove: true,
      projectRoot: process.cwd(),
      onMessage: (message) => {
        core.debug(`Agent message [${message.role}]: ${JSON.stringify(message.content).substring(0, 500)}`);
      },
    });

    // Dispatch to the appropriate task handler
    switch (task) {
      case 'review': {
        const context = getReviewContext();
        await reviewPR(agent, context);
        break;
      }
      case 'fix': {
        const context = getFixContext();
        await autoFix(agent, context);
        break;
      }
      case 'scan': {
        await securityScan(agent);
        break;
      }
    }

    core.info(`CodeBot AI task "${task}" completed successfully.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    core.error(`CodeBot AI failed: ${message}`);
    if (stack) {
      core.debug(stack);
    }
    core.setFailed(message);
  }
}

// Execute the action
run();
