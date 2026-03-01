/**
 * Example 01: Basic Chat
 *
 * The simplest possible CodeBot usage — send a message, stream the response.
 *
 * Usage:
 *   npx tsx examples/01-basic-chat.ts
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."    # or OPENAI_API_KEY
 */

import { Agent, AnthropicProvider } from 'codebot-ai';

async function main() {
  // Create a provider — replace with OpenAIProvider for GPT
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Create the agent
  const agent = new Agent({
    provider,
    model: 'claude-sonnet-4-20250514',
    autoApprove: true, // Skip permission prompts
  });

  // Stream events from the agent
  console.log('Agent response:\n');
  for await (const event of agent.run('What is the Fibonacci sequence? Show the first 10 numbers.')) {
    if (event.type === 'text') {
      process.stdout.write(event.text || '');
    }
  }
  console.log('\n');
}

main().catch(console.error);
