/**
 * Example 02: Automated Code Review
 *
 * Uses CodeBot as a library to review a file and report issues.
 * This demonstrates how to build a custom code review tool.
 *
 * Usage:
 *   npx tsx examples/02-code-review.ts [file-path]
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 */

import { Agent, AnthropicProvider } from 'codebot-ai';
import * as fs from 'fs';
import * as path from 'path';

async function reviewFile(filePath: string) {
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

  // Read the file to review
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const ext = path.extname(filePath);
  const prompt = `Review this ${ext} file for bugs, security issues, and code quality. Be concise.\n\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;

  console.log(`Reviewing: ${filePath}\n${'─'.repeat(50)}\n`);

  const output: string[] = [];
  for await (const event of agent.run(prompt)) {
    if (event.type === 'text' && event.text) {
      process.stdout.write(event.text);
      output.push(event.text);
    }
    if (event.type === 'usage') {
      const usage = event as { inputTokens?: number; outputTokens?: number; cost?: number };
      if (usage.cost) {
        console.log(`\n\n─── Cost: $${usage.cost.toFixed(4)} ───`);
      }
    }
  }

  console.log('\n');
}

const target = process.argv[2] || 'src/index.ts';
reviewFile(target).catch(console.error);
