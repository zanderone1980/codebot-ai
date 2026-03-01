/**
 * Prompt templates for CodeBot AI tasks.
 */

/**
 * Generate a prompt for reviewing a pull request diff.
 *
 * @param diff - The unified diff content of the pull request.
 * @returns A formatted prompt instructing the agent to review the diff.
 */
export function reviewPrompt(diff: string): string {
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

/**
 * Generate a prompt for fixing CI failures.
 *
 * @param errorLog - The error output from the CI run.
 * @returns A formatted prompt instructing the agent to fix the failures.
 */
export function fixPrompt(errorLog: string): string {
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

/**
 * Generate a prompt for performing a security scan.
 *
 * @returns A formatted prompt instructing the agent to scan for security issues.
 */
export function scanPrompt(): string {
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
