/**
 * Example 03: Security Scanner with SARIF Output
 *
 * Runs CodeBot's security scanning tools on a codebase and exports
 * findings in SARIF format for integration with GitHub Code Scanning.
 *
 * Usage:
 *   npx tsx examples/03-security-scan.ts [directory]
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 */

import { Agent, AnthropicProvider, exportSarif, sarifToString } from 'codebot-ai';
import * as fs from 'fs';
import * as path from 'path';

async function securityScan(targetDir: string) {
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const agent = new Agent({
    provider,
    model: 'claude-sonnet-4-20250514',
    autoApprove: true,
    maxIterations: 20,
    projectRoot: path.resolve(targetDir),
  });

  console.log(`🔍 Security scan: ${targetDir}\n`);

  const prompt = `Perform a security scan of this codebase. Look for:
1. Hardcoded credentials or API keys
2. SQL/command injection vulnerabilities
3. Path traversal risks
4. Insecure cryptographic practices
5. Missing input validation

Use read_file and grep tools to examine the code. Report findings with file paths and line numbers.`;

  for await (const event of agent.run(prompt)) {
    if (event.type === 'text' && event.text) {
      process.stdout.write(event.text);
    }
    if (event.type === 'tool_call') {
      const tc = event as { name?: string; tool?: string; risk?: { score: number; level: string } };
      const toolName = tc.name || tc.tool || 'unknown';
      const riskInfo = tc.risk ? ` [Risk: ${tc.risk.score} ${tc.risk.level}]` : '';
      console.log(`\n  ⚙ ${toolName}${riskInfo}`);
    }
  }

  // Export audit log to SARIF
  const auditLogger = agent.getAuditLogger();
  const entries = auditLogger.query();
  const sarif = exportSarif(entries);
  const sarifJson = sarifToString(sarif);

  const outputPath = path.join(targetDir, 'security-scan.sarif');
  fs.writeFileSync(outputPath, sarifJson, 'utf-8');
  console.log(`\n\n📄 SARIF report: ${outputPath}`);
  console.log(`   ${sarif.runs[0].results?.length || 0} findings exported`);
}

const target = process.argv[2] || '.';
securityScan(target).catch(console.error);
