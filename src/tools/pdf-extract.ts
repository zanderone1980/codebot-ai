import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

export class PdfExtractTool implements Tool {
  name = 'pdf_extract';
  description = 'Extract text and metadata from PDF files. Actions: text, info, pages.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only'];
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: text (extract text), info (file info), pages (page count)' },
      path: { type: 'string', description: 'Path to PDF file' },
      max_pages: { type: 'number', description: 'Max pages to extract (default: 10)' },
    },
    required: ['action', 'path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const filePath = args.path as string;

    if (!action) return 'Error: action is required';
    if (!filePath) return 'Error: path is required';
    if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') return `Error: not a PDF file (got ${ext})`;

    switch (action) {
      case 'text': return this.extractText(filePath, args);
      case 'info': return this.getInfo(filePath);
      case 'pages': return this.countPages(filePath);
      default: return `Error: unknown action "${action}". Use: text, info, pages`;
    }
  }

  private extractText(filePath: string, args: Record<string, unknown>): string {
    const maxPages = (args.max_pages as number) || 10;

    try {
      const content = fs.readFileSync(filePath);
      const text = this.extractFromBuffer(content, maxPages);

      if (!text.trim()) {
        return 'No extractable text found. The PDF may contain scanned images or use non-standard encoding.';
      }

      return `Extracted text from ${path.basename(filePath)}:\n\n${text}`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : 'failed to read PDF'}`;
    }
  }

  private getInfo(filePath: string): string {
    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    const content = fs.readFileSync(filePath);
    const pages = this.estimatePageCount(content);

    // Extract PDF metadata
    const text = content.toString('latin1');
    const title = this.extractMeta(text, 'Title');
    const author = this.extractMeta(text, 'Author');
    const creator = this.extractMeta(text, 'Creator');

    let result = `File: ${path.basename(filePath)}\nSize: ${sizeMB} MB\nPages: ~${pages}\nModified: ${stat.mtime.toISOString()}`;
    if (title) result += `\nTitle: ${title}`;
    if (author) result += `\nAuthor: ${author}`;
    if (creator) result += `\nCreator: ${creator}`;

    return result;
  }

  private countPages(filePath: string): string {
    const content = fs.readFileSync(filePath);
    const pages = this.estimatePageCount(content);
    return `${path.basename(filePath)}: approximately ${pages} page(s)`;
  }

  private estimatePageCount(buf: Buffer): number {
    // Count /Type /Page occurrences (not /Pages)
    const text = buf.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page(?!\s*s)/g);
    return matches ? matches.length : 1;
  }

  private extractFromBuffer(buf: Buffer, maxPages: number): string {
    // Simple text extraction — find text between BT/ET markers and decode
    const text = buf.toString('latin1');
    const chunks: string[] = [];
    let pageCount = 0;

    // Find stream content
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    let match: RegExpExecArray | null;

    while ((match = streamRegex.exec(text)) !== null && pageCount < maxPages) {
      const stream = match[1];

      // Extract text from BT...ET blocks
      const btRegex = /BT\s([\s\S]*?)ET/g;
      let btMatch: RegExpExecArray | null;

      while ((btMatch = btRegex.exec(stream)) !== null) {
        const block = btMatch[1];

        // Extract text strings in parentheses: (Hello World) Tj
        const tjRegex = /\(([^)]*)\)\s*Tj/g;
        let tjMatch: RegExpExecArray | null;
        while ((tjMatch = tjRegex.exec(block)) !== null) {
          const decoded = this.decodePdfString(tjMatch[1]);
          if (decoded.trim()) chunks.push(decoded);
        }

        // Extract TJ arrays: [(text1) 10 (text2)] TJ
        const tjArrayRegex = /\[(.*?)\]\s*TJ/g;
        let arrMatch: RegExpExecArray | null;
        while ((arrMatch = tjArrayRegex.exec(block)) !== null) {
          const inner = arrMatch[1];
          const strRegex = /\(([^)]*)\)/g;
          let strMatch: RegExpExecArray | null;
          const parts: string[] = [];
          while ((strMatch = strRegex.exec(inner)) !== null) {
            parts.push(this.decodePdfString(strMatch[1]));
          }
          if (parts.length > 0) chunks.push(parts.join(''));
        }
      }

      if (chunks.length > 0) pageCount++;
    }

    // Clean up and join
    return chunks
      .map(c => c.trim())
      .filter(c => c.length > 0)
      .join('\n')
      .substring(0, 20_000);
  }

  private decodePdfString(s: string): string {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\([()])/g, '$1');
  }

  private extractMeta(text: string, key: string): string | null {
    const regex = new RegExp(`/${key}\\s*\\(([^)]*)\\)`);
    const match = text.match(regex);
    return match ? match[1] : null;
  }
}
