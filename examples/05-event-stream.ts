/**
 * Example 05: Event Stream Processing
 *
 * Demonstrates how to process every event type from the agent's
 * async generator. Useful for building custom UIs or integrations.
 *
 * Usage:
 *   npx tsx examples/05-event-stream.ts
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 */

import { Agent, AnthropicProvider } from 'codebot-ai';
import type { AgentEvent } from 'codebot-ai';

async function processEvents() {
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const agent = new Agent({
    provider,
    model: 'claude-sonnet-4-20250514',
    autoApprove: true,
    maxIterations: 10,
    projectRoot: process.cwd(),
  });

  // Counters for summary
  let textChunks = 0;
  let toolCalls = 0;
  let totalTokens = 0;

  console.log('Processing agent events...\n');

  for await (const event of agent.run('List the TypeScript files in the src/ directory of this project')) {
    switch (event.type) {
      case 'text': {
        textChunks++;
        // In a real UI, you'd stream this to the user
        process.stdout.write(event.text || '');
        break;
      }

      case 'thinking': {
        // Extended thinking (Claude models)
        console.log(`\n💭 [thinking] ${(event as any).content?.substring(0, 100)}...`);
        break;
      }

      case 'tool_call': {
        toolCalls++;
        const tc = event as any;
        const risk = tc.risk ? ` | Risk: ${tc.risk.score}/100 (${tc.risk.level})` : '';
        console.log(`\n🔧 Tool: ${tc.name || tc.tool}${risk}`);
        break;
      }

      case 'tool_result': {
        const tr = event as any;
        const preview = tr.toolResult?.result?.substring(0, 100) || '';
        const status = tr.toolResult?.is_error ? '❌' : '✅';
        console.log(`   ${status} ${preview}${preview.length >= 100 ? '...' : ''}`);
        break;
      }

      case 'usage': {
        const u = event as any;
        if (u.inputTokens) totalTokens += u.inputTokens;
        if (u.outputTokens) totalTokens += u.outputTokens;
        break;
      }

      case 'error': {
        console.error(`\n❌ Error: ${(event as any).error || (event as any).content}`);
        break;
      }

      case 'done': {
        console.log('\n\n✅ Agent finished');
        break;
      }

      default: {
        // Other event types: system, session_start, etc.
        break;
      }
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`📊 Summary:`);
  console.log(`   Text chunks: ${textChunks}`);
  console.log(`   Tool calls:  ${toolCalls}`);
  console.log(`   Total tokens: ${totalTokens}`);
}

processEvents().catch(console.error);
