import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MEMORY_DIR = path.join(os.homedir(), '.codebot', 'memory');
const GLOBAL_MEMORY = path.join(MEMORY_DIR, 'MEMORY.md');

export interface MemoryEntry {
  key: string;
  value: string;
  source: 'user' | 'agent';
  created: string;
}

/**
 * Persistent memory system for CodeBot.
 * Stores project-level and global notes that survive across sessions.
 * Memory is injected into the system prompt so the model always has context.
 */
export class MemoryManager {
  private projectDir: string;
  private globalDir: string;

  constructor(projectRoot?: string) {
    this.projectDir = projectRoot
      ? path.join(projectRoot, '.codebot', 'memory')
      : '';
    this.globalDir = MEMORY_DIR;
    fs.mkdirSync(this.globalDir, { recursive: true });
    if (this.projectDir) {
      fs.mkdirSync(this.projectDir, { recursive: true });
    }
  }

  /** Read the global memory file */
  readGlobal(): string {
    if (fs.existsSync(GLOBAL_MEMORY)) {
      return fs.readFileSync(GLOBAL_MEMORY, 'utf-8');
    }
    return '';
  }

  /** Read project-level memory */
  readProject(): string {
    if (!this.projectDir) return '';
    const memFile = path.join(this.projectDir, 'MEMORY.md');
    if (fs.existsSync(memFile)) {
      return fs.readFileSync(memFile, 'utf-8');
    }
    return '';
  }

  /** Write to global memory */
  writeGlobal(content: string): void {
    fs.writeFileSync(GLOBAL_MEMORY, content);
  }

  /** Write to project memory */
  writeProject(content: string): void {
    if (!this.projectDir) return;
    const memFile = path.join(this.projectDir, 'MEMORY.md');
    fs.writeFileSync(memFile, content);
  }

  /** Append an entry to global memory */
  appendGlobal(entry: string): void {
    const current = this.readGlobal();
    const updated = current ? `${current.trimEnd()}\n\n${entry}` : entry;
    this.writeGlobal(updated);
  }

  /** Append an entry to project memory */
  appendProject(entry: string): void {
    if (!this.projectDir) return;
    const current = this.readProject();
    const updated = current ? `${current.trimEnd()}\n\n${entry}` : entry;
    this.writeProject(updated);
  }

  /** Read all memory files from a directory */
  private readDir(dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    if (!fs.existsSync(dir)) return files;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      files[name] = fs.readFileSync(path.join(dir, name), 'utf-8');
    }
    return files;
  }

  /** Get all memory content formatted for system prompt injection */
  getContextBlock(): string {
    const parts: string[] = [];

    const global = this.readGlobal();
    if (global.trim()) {
      parts.push(`## Global Memory\n${global.trim()}`);
    }

    // Read additional global topic files
    const globalFiles = this.readDir(this.globalDir);
    for (const [name, content] of Object.entries(globalFiles)) {
      if (name === 'MEMORY.md' || !content.trim()) continue;
      parts.push(`## ${name.replace('.md', '')}\n${content.trim()}`);
    }

    const project = this.readProject();
    if (project.trim()) {
      parts.push(`## Project Memory\n${project.trim()}`);
    }

    // Read additional project topic files
    if (this.projectDir) {
      const projFiles = this.readDir(this.projectDir);
      for (const [name, content] of Object.entries(projFiles)) {
        if (name === 'MEMORY.md' || !content.trim()) continue;
        parts.push(`## Project: ${name.replace('.md', '')}\n${content.trim()}`);
      }
    }

    if (parts.length === 0) return '';
    return `\n\n--- Persistent Memory ---\n${parts.join('\n\n')}`;
  }

  /** List all memory files */
  list(): Array<{ scope: 'global' | 'project'; file: string; size: number }> {
    const result: Array<{ scope: 'global' | 'project'; file: string; size: number }> = [];

    if (fs.existsSync(this.globalDir)) {
      for (const name of fs.readdirSync(this.globalDir)) {
        if (!name.endsWith('.md')) continue;
        const stat = fs.statSync(path.join(this.globalDir, name));
        result.push({ scope: 'global', file: name, size: stat.size });
      }
    }

    if (this.projectDir && fs.existsSync(this.projectDir)) {
      for (const name of fs.readdirSync(this.projectDir)) {
        if (!name.endsWith('.md')) continue;
        const stat = fs.statSync(path.join(this.projectDir, name));
        result.push({ scope: 'project', file: name, size: stat.size });
      }
    }

    return result;
  }
}
