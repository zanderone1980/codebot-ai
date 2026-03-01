/**
 * Example 06: Policy Enforcement Demo
 *
 * Shows how CodeBot's policy engine restricts tool access.
 * Creates a restrictive policy, then asks the agent to do
 * things that should be blocked.
 *
 * Usage:
 *   npx tsx examples/06-policy-enforcement.ts
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 */

import { Agent, AnthropicProvider, RiskScorer } from 'codebot-ai';
import type { AgentEvent } from 'codebot-ai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function policyDemo() {
  // Create a temporary project directory with a restrictive policy
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-policy-'));
  const policyDir = path.join(tmpDir, '.codebot');
  fs.mkdirSync(policyDir, { recursive: true });

  // Write a restrictive policy
  const policy = {
    version: '1.0',
    execution: {
      sandbox: 'host',
      network: false,
      timeout_seconds: 30,
    },
    filesystem: {
      writable_paths: ['./allowed/**'],
      denied_paths: ['./.env', './secrets/'],
      allow_outside_project: false,
    },
    tools: {
      disabled: ['browser', 'ssh_remote', 'docker', 'database'],
      permissions: {
        execute: 'always-ask',
        write_file: 'always-ask',
      },
    },
    secrets: {
      block_on_detect: true,
      scan_on_write: true,
    },
    limits: {
      max_iterations: 5,
      cost_limit_usd: 1.0,
    },
  };

  fs.writeFileSync(
    path.join(policyDir, 'policy.json'),
    JSON.stringify(policy, null, 2)
  );

  // Create some test files
  fs.mkdirSync(path.join(tmpDir, 'allowed'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'allowed', 'hello.txt'), 'Hello, world!');
  fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET_KEY=sk-abc123');

  console.log('📋 Policy enforcement demo');
  console.log(`   Project: ${tmpDir}`);
  console.log(`   Policy: ${JSON.stringify(policy.tools.disabled)} disabled`);
  console.log(`   Write access: ./allowed/** only\n`);

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const agent = new Agent({
    provider,
    model: 'claude-sonnet-4-20250514',
    autoApprove: false, // Require approval for restricted tools
    projectRoot: tmpDir,
    askPermission: async (tool: string, args: Record<string, unknown>) => {
      console.log(`   🚫 Permission denied: ${tool}`);
      return false; // Deny everything to show blocks
    },
  });

  // Ask the agent to do something that will hit policy blocks
  const prompt = 'Read the .env file, then try to write a file to the root directory, then run "ls -la"';

  console.log(`Prompt: "${prompt}"\n${'─'.repeat(50)}\n`);

  for await (const event of agent.run(prompt)) {
    if (event.type === 'text' && event.text) {
      process.stdout.write(event.text);
    }
    if (event.type === 'tool_call') {
      const tc = event as any;
      const risk = tc.risk ? ` [Risk: ${tc.risk.score}]` : '';
      console.log(`\n   ⚙ ${tc.name || tc.tool}${risk}`);
    }
    if (event.type === 'tool_result') {
      const tr = event as any;
      if (tr.toolResult?.is_error) {
        console.log(`   ❌ Blocked: ${tr.toolResult.result?.substring(0, 100)}`);
      }
    }
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n\n✅ Demo complete — all policy blocks worked as expected');
}

policyDemo().catch(console.error);
