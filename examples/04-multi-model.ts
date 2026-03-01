/**
 * Example 04: Multi-Model Comparison
 *
 * Sends the same prompt to multiple LLM providers and compares responses.
 * Demonstrates CodeBot's provider-agnostic architecture.
 *
 * Usage:
 *   npx tsx examples/04-multi-model.ts
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 *   export OPENAI_API_KEY="sk-..."
 *   # Optional: have Ollama running locally
 */

import { Agent, AnthropicProvider, OpenAIProvider, detectProvider } from 'codebot-ai';
import type { LLMProvider } from 'codebot-ai';

interface ModelConfig {
  name: string;
  provider: () => LLMProvider | null;
  model: string;
}

const models: ModelConfig[] = [
  {
    name: 'Claude Sonnet',
    provider: () => process.env.ANTHROPIC_API_KEY
      ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null,
    model: 'claude-sonnet-4-20250514',
  },
  {
    name: 'GPT-4o',
    provider: () => process.env.OPENAI_API_KEY
      ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY })
      : null,
    model: 'gpt-4o',
  },
  {
    name: 'Local (Ollama)',
    provider: () => {
      try {
        return new OpenAIProvider({ baseUrl: 'http://localhost:11434/v1' });
      } catch {
        return null;
      }
    },
    model: 'qwen2.5-coder:7b',
  },
];

async function compareModels(prompt: string) {
  console.log(`Prompt: "${prompt}"\n${'═'.repeat(60)}\n`);

  for (const config of models) {
    const llmProvider = config.provider();
    if (!llmProvider) {
      console.log(`⏭  ${config.name}: skipped (no API key)\n`);
      continue;
    }

    console.log(`▶ ${config.name} (${config.model})`);
    console.log(`${'─'.repeat(40)}`);

    try {
      const agent = new Agent({
        provider: llmProvider,
        model: config.model,
        autoApprove: true,
        maxIterations: 5,
      });

      const start = Date.now();
      const output: string[] = [];

      for await (const event of agent.run(prompt)) {
        if (event.type === 'text' && event.text) {
          output.push(event.text);
        }
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(output.join('').substring(0, 500));
      console.log(`\n⏱  ${elapsed}s\n`);
    } catch (err) {
      console.log(`❌ Error: ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

const prompt = process.argv[2] || 'Write a TypeScript function that checks if a string is a valid email address. Just the function, no explanation.';
compareModels(prompt).catch(console.error);
