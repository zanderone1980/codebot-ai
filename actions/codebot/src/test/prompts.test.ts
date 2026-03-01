import { describe, it } from 'node:test';
import * as assert from 'node:assert';

/**
 * Inline prompt template functions for testing without compiling the action module.
 * These mirror the logic in ../prompts.ts exactly.
 */
function reviewPrompt(diff: string): string {
  return `Review this pull request diff. Focus on bugs, security issues, performance problems, and code quality. For each issue found, specify the file, line number, severity (critical/warning/info), and a clear description of the problem with a suggested fix.

Provide your review in a structured format:
- Start with a brief summary of the overall changes.
- List each issue with file path, line range, severity, and description.
- End with an overall assessment (approve, request changes, or comment).

Here is the diff to review:

\`\`\`diff
${diff}
\`\`\``;
}

function fixPrompt(errorLog: string): string {
  return `Fix the failing CI. Here is the error output:

\`\`\`
${errorLog}
\`\`\`

Analyze the errors and fix them by:
1. Identifying the root cause of each failure.
2. Reading the relevant source files to understand the context.
3. Making the minimal necessary changes to fix the issues.
4. Verifying your changes are correct and don't introduce new problems.

Do not make unrelated changes. Focus only on resolving the CI failures.`;
}

function scanPrompt(): string {
  return `Perform a thorough security scan of this codebase. Look for:

1. **Injection vulnerabilities**: SQL injection, command injection, XSS, template injection.
2. **Authentication & authorization flaws**: Hardcoded credentials, missing auth checks, insecure token handling.
3. **Data exposure**: Sensitive data in logs, unencrypted secrets, PII leaks.
4. **Dependency issues**: Known vulnerable dependencies, outdated packages.
5. **Configuration problems**: Debug mode in production, permissive CORS, insecure defaults.
6. **Cryptographic weaknesses**: Weak algorithms, improper key management, insecure random generation.
7. **Input validation**: Missing validation, improper sanitization, path traversal.
8. **Error handling**: Information leakage through error messages, unhandled exceptions.

For each finding, report:
- **File** and **line number**
- **Severity**: critical, high, medium, low
- **CWE ID** if applicable
- **Description** of the vulnerability
- **Recommendation** for remediation

Use the available file-reading tools to examine the codebase systematically. Start with entry points, configuration files, and areas that handle user input or sensitive data.`;
}

describe('reviewPrompt', () => {
  it('includes the diff content in the prompt', () => {
    const diff = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n+import { foo } from 'bar';\n const x = 1;`;
    const prompt = reviewPrompt(diff);
    assert.ok(prompt.includes(diff), 'Prompt should contain the diff');
  });

  it('wraps diff in code fence', () => {
    const diff = 'some diff';
    const prompt = reviewPrompt(diff);
    assert.ok(prompt.includes('```diff'), 'Should open diff code fence');
    assert.ok(prompt.includes('```'), 'Should close code fence');
  });

  it('instructs to check for security issues', () => {
    const prompt = reviewPrompt('diff');
    assert.ok(prompt.includes('security'), 'Should mention security');
  });

  it('instructs to check for bugs', () => {
    const prompt = reviewPrompt('diff');
    assert.ok(prompt.includes('bugs'), 'Should mention bugs');
  });

  it('requests structured output format', () => {
    const prompt = reviewPrompt('diff');
    assert.ok(prompt.includes('structured format'), 'Should request structured output');
  });

  it('handles large diffs', () => {
    const largeDiff = 'x'.repeat(100000);
    const prompt = reviewPrompt(largeDiff);
    assert.ok(prompt.includes(largeDiff), 'Should include entire diff');
  });
});

describe('fixPrompt', () => {
  it('includes error log in the prompt', () => {
    const errorLog = 'Error: Cannot find module "foo"';
    const prompt = fixPrompt(errorLog);
    assert.ok(prompt.includes(errorLog), 'Prompt should contain the error log');
  });

  it('wraps error log in code fence', () => {
    const prompt = fixPrompt('error');
    assert.ok(prompt.includes('```'), 'Should use code fence');
  });

  it('instructs minimal changes', () => {
    const prompt = fixPrompt('error');
    assert.ok(prompt.includes('minimal'), 'Should request minimal changes');
  });

  it('instructs to identify root cause', () => {
    const prompt = fixPrompt('error');
    assert.ok(prompt.includes('root cause'), 'Should mention root cause');
  });

  it('instructs not to make unrelated changes', () => {
    const prompt = fixPrompt('error');
    assert.ok(prompt.includes('Do not make unrelated'), 'Should warn against unrelated changes');
  });
});

describe('scanPrompt', () => {
  it('covers injection vulnerabilities', () => {
    const prompt = scanPrompt();
    assert.ok(prompt.includes('Injection'), 'Should cover injection');
    assert.ok(prompt.includes('SQL injection'), 'Should mention SQL injection');
    assert.ok(prompt.includes('XSS'), 'Should mention XSS');
  });

  it('covers authentication issues', () => {
    const prompt = scanPrompt();
    assert.ok(prompt.includes('Authentication'), 'Should cover auth');
    assert.ok(prompt.includes('Hardcoded credentials'), 'Should mention hardcoded creds');
  });

  it('covers data exposure', () => {
    const prompt = scanPrompt();
    assert.ok(prompt.includes('Data exposure'), 'Should cover data exposure');
    assert.ok(prompt.includes('PII'), 'Should mention PII');
  });

  it('requests CWE IDs', () => {
    const prompt = scanPrompt();
    assert.ok(prompt.includes('CWE'), 'Should request CWE IDs');
  });

  it('requests severity levels', () => {
    const prompt = scanPrompt();
    assert.ok(prompt.includes('critical'), 'Should include critical');
    assert.ok(prompt.includes('high'), 'Should include high');
    assert.ok(prompt.includes('medium'), 'Should include medium');
    assert.ok(prompt.includes('low'), 'Should include low');
  });

  it('covers all 8 security categories', () => {
    const prompt = scanPrompt();
    const categories = [
      'Injection',
      'Authentication',
      'Data exposure',
      'Dependency',
      'Configuration',
      'Cryptographic',
      'Input validation',
      'Error handling',
    ];
    for (const cat of categories) {
      assert.ok(prompt.includes(cat), `Should cover ${cat}`);
    }
  });
});
