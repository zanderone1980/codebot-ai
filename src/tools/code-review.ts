import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

interface Issue {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

const SECURITY_PATTERNS: Array<{ pattern: RegExp; rule: string; message: string; severity: Issue['severity'] }> = [
  { pattern: /\beval\s*\(/, rule: 'no-eval', message: 'eval() is a security risk — allows arbitrary code execution', severity: 'error' },
  { pattern: /new\s+Function\s*\(/, rule: 'no-new-function', message: 'new Function() is equivalent to eval()', severity: 'error' },
  { pattern: /child_process.*exec(?!Sync)/, rule: 'unsafe-exec', message: 'exec() can be vulnerable to command injection — prefer execFile()', severity: 'warning' },
  { pattern: /innerHTML\s*=/, rule: 'no-innerhtml', message: 'innerHTML is vulnerable to XSS attacks', severity: 'warning' },
  { pattern: /document\.write\s*\(/, rule: 'no-document-write', message: 'document.write() is a security and performance issue', severity: 'warning' },
  { pattern: /(?:password|secret|api.?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, rule: 'hardcoded-secret', message: 'Possible hardcoded secret/credential', severity: 'error' },
  { pattern: /\bsqlite3?\s.*\+\s*(?:req\.|args\.|input)/i, rule: 'sql-injection', message: 'Possible SQL injection — use parameterized queries', severity: 'error' },
  { pattern: /https?:\/\/[^'"]*['"]\s*\+/, rule: 'url-injection', message: 'String concatenation in URL — possible injection', severity: 'warning' },
  { pattern: /console\.(log|debug|info)\(/, rule: 'no-console', message: 'Console statement (consider removing for production)', severity: 'info' },
  { pattern: /TODO|FIXME|HACK|XXX/i, rule: 'todo-comment', message: 'TODO/FIXME comment found', severity: 'info' },
];

export class CodeReviewTool implements Tool {
  name = 'code_review';
  description = 'Review code for security issues, complexity, and code smells. Actions: security, complexity, review (full).';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only'];
  cacheable = true;
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: security (scan for vulnerabilities), complexity (function/nesting analysis), review (full review)' },
      path: { type: 'string', description: 'File or directory to review' },
      severity: { type: 'string', description: 'Minimum severity to report: error, warning, info (default: warning)' },
    },
    required: ['action', 'path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const targetPath = args.path as string;

    if (!action) return 'Error: action is required';
    if (!targetPath) return 'Error: path is required';
    if (!fs.existsSync(targetPath)) return `Error: path not found: ${targetPath}`;

    const minSeverity = (args.severity as string) || 'warning';

    switch (action) {
      case 'security': return this.securityScan(targetPath, minSeverity);
      case 'complexity': return this.complexityAnalysis(targetPath);
      case 'review': {
        const sec = this.securityScan(targetPath, minSeverity);
        const comp = this.complexityAnalysis(targetPath);
        return `=== Security Review ===\n${sec}\n\n=== Complexity Analysis ===\n${comp}`;
      }
      default: return `Error: unknown action "${action}". Use: security, complexity, review`;
    }
  }

  private securityScan(targetPath: string, minSeverity: string): string {
    const issues: Issue[] = [];
    const sevOrder: Record<string, number> = { error: 3, warning: 2, info: 1 };
    const minLevel = sevOrder[minSeverity] || 2;

    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      this.scanFile(targetPath, issues);
    } else {
      this.scanDir(targetPath, issues);
    }

    // Filter by severity
    const filtered = issues.filter(i => (sevOrder[i.severity] || 0) >= minLevel);

    if (filtered.length === 0) return 'No security issues found.';

    const errors = filtered.filter(i => i.severity === 'error').length;
    const warnings = filtered.filter(i => i.severity === 'warning').length;
    const infos = filtered.filter(i => i.severity === 'info').length;

    const icons: Record<string, string> = { error: 'X', warning: '!', info: 'i' };
    const lines = filtered.slice(0, 50).map(i =>
      `  [${icons[i.severity]}] ${i.file}:${i.line} ${i.rule} — ${i.message}`
    );

    return `Found ${filtered.length} issue(s): ${errors} errors, ${warnings} warnings, ${infos} info\n${lines.join('\n')}`;
  }

  private complexityAnalysis(targetPath: string): string {
    const stat = fs.statSync(targetPath);
    const results: string[] = [];

    if (stat.isFile()) {
      this.analyzeFileComplexity(targetPath, results);
    } else {
      this.analyzeDir(targetPath, results);
    }

    if (results.length === 0) return 'No complexity issues found.';
    return results.join('\n');
  }

  private scanFile(filePath: string, issues: Issue[]): void {
    const ext = path.extname(filePath);
    if (!['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rb', '.java'].includes(ext)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        for (const check of SECURITY_PATTERNS) {
          if (check.pattern.test(lines[i])) {
            issues.push({
              file: filePath, line: i + 1,
              severity: check.severity, rule: check.rule, message: check.message,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  private scanDir(dir: string, issues: Issue[]): void {
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__']);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this.scanDir(full, issues);
      } else {
        this.scanFile(full, issues);
      }
    }
  }

  private analyzeFileComplexity(filePath: string, results: string[]): void {
    const ext = path.extname(filePath);
    if (!['.ts', '.js', '.tsx', '.jsx', '.py', '.go'].includes(ext)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let currentFunc = '';
      let funcStart = 0;
      let maxNesting = 0;
      let currentNesting = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect function starts
        const funcMatch = line.match(/(?:function|async function|def|fn|func)\s+(\w+)|(\w+)\s*[:=]\s*(?:async\s+)?\(/);
        if (funcMatch) {
          // Report previous function if long
          if (currentFunc && (i - funcStart) > 50) {
            results.push(`  [!] ${filePath}:${funcStart + 1} "${currentFunc}" is ${i - funcStart} lines long (consider breaking up)`);
          }
          currentFunc = funcMatch[1] || funcMatch[2] || '';
          funcStart = i;
          maxNesting = 0;
        }

        // Track nesting
        const opens = (line.match(/[{(]/g) || []).length;
        const closes = (line.match(/[})]/g) || []).length;
        currentNesting += opens - closes;
        if (currentNesting > maxNesting) maxNesting = currentNesting;

        if (maxNesting > 5 && currentFunc) {
          results.push(`  [!] ${filePath}:${i + 1} deep nesting (${maxNesting} levels) in "${currentFunc}"`);
          maxNesting = 0; // Don't re-report
        }
      }

      // Check last function
      if (currentFunc && (lines.length - funcStart) > 50) {
        results.push(`  [!] ${filePath}:${funcStart + 1} "${currentFunc}" is ${lines.length - funcStart} lines long`);
      }

      // File-level checks
      if (lines.length > 500) {
        results.push(`  [i] ${filePath}: ${lines.length} lines — consider splitting into modules`);
      }
    } catch { /* skip */ }
  }

  private analyzeDir(dir: string, results: string[]): void {
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this.analyzeDir(full, results);
      else this.analyzeFileComplexity(full, results);
    }
  }
}
