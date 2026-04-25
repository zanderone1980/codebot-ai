import * as fs from 'fs';
import { execSync } from 'child_process';
import { Tool, CapabilityLabel } from '../types';

export class DiffViewerTool implements Tool {
  name = 'diff_viewer';
  description = 'View diffs. Actions: files (compare two files), git_diff (working tree changes), staged (staged changes), commit (show a commit diff).';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only', 'run-cmd'];
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: files, git_diff, staged, commit' },
      file_a: { type: 'string', description: 'First file path (for "files" action)' },
      file_b: { type: 'string', description: 'Second file path (for "files" action)' },
      path: { type: 'string', description: 'File or directory to diff (for git_diff/staged)' },
      ref: { type: 'string', description: 'Commit hash or ref (for "commit" action)' },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    if (!action) return 'Error: action is required';

    switch (action) {
      case 'files': return this.diffFiles(args);
      case 'git_diff': return this.gitDiff(args);
      case 'staged': return this.gitStaged(args);
      case 'commit': return this.gitCommitDiff(args);
      default: return `Error: unknown action "${action}". Use: files, git_diff, staged, commit`;
    }
  }

  private diffFiles(args: Record<string, unknown>): string {
    const fileA = args.file_a as string;
    const fileB = args.file_b as string;
    if (!fileA || !fileB) return 'Error: file_a and file_b are required';

    let contentA: string, contentB: string;
    try { contentA = fs.readFileSync(fileA, 'utf-8'); } catch { return `Error: cannot read ${fileA}`; }
    try { contentB = fs.readFileSync(fileB, 'utf-8'); } catch { return `Error: cannot read ${fileB}`; }

    const linesA = contentA.split('\n');
    const linesB = contentB.split('\n');
    const diff: string[] = [`--- ${fileA}`, `+++ ${fileB}`];

    // Simple line-by-line diff
    const maxLen = Math.max(linesA.length, linesB.length);
    let changes = 0;

    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i];
      const b = linesB[i];

      if (a === undefined && b !== undefined) {
        diff.push(`+${i + 1}: ${b}`);
        changes++;
      } else if (b === undefined && a !== undefined) {
        diff.push(`-${i + 1}: ${a}`);
        changes++;
      } else if (a !== b) {
        diff.push(`-${i + 1}: ${a}`);
        diff.push(`+${i + 1}: ${b}`);
        changes++;
      }
    }

    if (changes === 0) return 'Files are identical.';
    return `${changes} line(s) differ:\n${diff.join('\n')}`;
  }

  private gitDiff(args: Record<string, unknown>): string {
    const target = (args.path as string) || '';
    return this.runGit(`diff ${target}`.trim());
  }

  private gitStaged(args: Record<string, unknown>): string {
    const target = (args.path as string) || '';
    return this.runGit(`diff --staged ${target}`.trim());
  }

  private gitCommitDiff(args: Record<string, unknown>): string {
    const ref = args.ref as string;
    if (!ref) return 'Error: ref (commit hash) is required';

    // Sanitize ref
    if (!/^[a-zA-Z0-9_\-./~^]+$/.test(ref)) return 'Error: invalid ref format';
    return this.runGit(`show --stat --patch ${ref}`);
  }

  private runGit(cmd: string): string {
    try {
      const output = execSync(`git ${cmd}`, {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || 'No changes.';
    } catch (err: unknown) {
      const e = err as { stderr?: string };
      return `Error: ${(e.stderr || 'git command failed').trim()}`;
    }
  }
}
