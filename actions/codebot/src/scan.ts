import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { exportSarif, sarifToString } from 'codebot-ai';
import type { Agent, AgentEvent, AuditEntry } from 'codebot-ai';
import { scanPrompt } from './prompts';

/**
 * Default path for the SARIF output file.
 */
const SARIF_OUTPUT_PATH = 'codebot-scan-results.sarif';

/**
 * Run a security scan of the codebase and upload results as SARIF.
 *
 * The agent performs a thorough security analysis using its tools, then
 * the audit log entries are exported to SARIF format and uploaded to
 * GitHub Code Scanning.
 *
 * @param agent - The CodeBot AI agent instance.
 */
export async function securityScan(agent: Agent): Promise<void> {
  // Run the agent with the scan prompt
  core.info('Running AI security scan...');
  const prompt = scanPrompt();
  const outputParts: string[] = [];

  const events: AsyncGenerator<AgentEvent> = agent.run(prompt);
  for await (const event of events) {
    if (event.type === 'text' && typeof event.content === 'string') {
      outputParts.push(event.content);
    }
    if (event.type === 'tool_use') {
      core.info(`Scanning with tool: ${event.name}`);
    }
    if (event.type === 'error') {
      core.warning(`Agent error during scan: ${event.content}`);
    }
  }

  // Retrieve audit entries from the agent's audit logger
  const auditLogger = agent.getAuditLogger();
  const entries: AuditEntry[] = auditLogger.query();

  core.info(`Security scan complete. Found ${entries.length} audit entries.`);

  // Export findings to SARIF format
  const sarif = exportSarif(entries);
  const sarifContent = sarifToString(sarif);

  // Write SARIF file to disk
  const sarifPath = path.resolve(process.cwd(), SARIF_OUTPUT_PATH);
  fs.writeFileSync(sarifPath, sarifContent, 'utf-8');
  core.info(`SARIF results written to: ${sarifPath}`);

  // Set the SARIF file path as an output
  core.setOutput('sarif-file', sarifPath);

  // Upload SARIF to GitHub Code Scanning
  await uploadSarif(sarifContent);

  // Log summary
  const scanSummary = outputParts.join('');
  if (scanSummary.trim().length > 0) {
    core.info('--- Scan Summary ---');
    core.info(scanSummary.substring(0, 2000));
    if (scanSummary.length > 2000) {
      core.info('... (summary truncated, see SARIF file for full details)');
    }
  }
}

/**
 * Upload SARIF content to GitHub Code Scanning via the API.
 *
 * @param sarifContent - The SARIF JSON string to upload.
 */
async function uploadSarif(sarifContent: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN || core.getInput('api-key');
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const commitSha = github.context.sha;
  const ref = github.context.ref;

  try {
    // Compress SARIF content to base64 for the API
    const sarifBase64 = Buffer.from(sarifContent, 'utf-8').toString('base64');

    core.info('Uploading SARIF results to GitHub Code Scanning...');
    await octokit.rest.codeScanning.uploadSarif({
      owner,
      repo,
      commit_sha: commitSha,
      ref,
      sarif: sarifBase64,
    });

    core.info('SARIF results uploaded successfully to GitHub Code Scanning.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Code scanning may not be enabled for the repository
    if (message.includes('not enabled') || message.includes('403')) {
      core.warning(
        'GitHub Code Scanning is not enabled for this repository. ' +
        'SARIF file has been written to disk but could not be uploaded. ' +
        'Enable GitHub Advanced Security to use code scanning.'
      );
    } else {
      core.warning(`Failed to upload SARIF results: ${message}`);
    }
  }
}
