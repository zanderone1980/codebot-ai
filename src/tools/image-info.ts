import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class ImageInfoTool implements Tool {
  name = 'image_info';
  description = 'Get image file information — dimensions, format, file size. Supports PNG, JPEG, GIF, BMP, SVG.';
  permission: Tool['permission'] = 'auto';
  cacheable = true;
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to image file' },
      base64: { type: 'boolean', description: 'Also return base64-encoded content (default: false)' },
    },
    required: ['path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.path as string;
    if (!filePath) return 'Error: path is required';
    if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const sizeKB = (stat.size / 1024).toFixed(1);

    let width = 0, height = 0, format = 'unknown';

    try {
      const buf = Buffer.alloc(Math.min(stat.size, 32));
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);

      // PNG: bytes 16-23 contain width (4 bytes) and height (4 bytes)
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        format = 'PNG';
        width = buf.readUInt32BE(16);
        height = buf.readUInt32BE(20);
      }
      // JPEG: SOI marker
      else if (buf[0] === 0xFF && buf[1] === 0xD8) {
        format = 'JPEG';
        const dims = this.readJpegDimensions(filePath);
        width = dims.width;
        height = dims.height;
      }
      // GIF: GIF87a or GIF89a
      else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        format = 'GIF';
        width = buf.readUInt16LE(6);
        height = buf.readUInt16LE(8);
      }
      // BMP
      else if (buf[0] === 0x42 && buf[1] === 0x4D) {
        format = 'BMP';
        const fullBuf = Buffer.alloc(26);
        const fd2 = fs.openSync(filePath, 'r');
        fs.readSync(fd2, fullBuf, 0, 26, 0);
        fs.closeSync(fd2);
        width = fullBuf.readInt32LE(18);
        height = Math.abs(fullBuf.readInt32LE(22));
      }
      // SVG
      else if (ext === '.svg') {
        format = 'SVG';
        const content = fs.readFileSync(filePath, 'utf-8').substring(0, 1000);
        const wMatch = content.match(/width=["'](\d+)/);
        const hMatch = content.match(/height=["'](\d+)/);
        const vbMatch = content.match(/viewBox=["']\s*\d+\s+\d+\s+(\d+)\s+(\d+)/);
        if (wMatch) width = parseInt(wMatch[1]);
        if (hMatch) height = parseInt(hMatch[1]);
        if (!width && vbMatch) { width = parseInt(vbMatch[1]); height = parseInt(vbMatch[2]); }
      }
    } catch {
      // Could not read dimensions
    }

    let result = `File: ${path.basename(filePath)}\nFormat: ${format}\nSize: ${sizeKB} KB`;
    if (width > 0 && height > 0) {
      result += `\nDimensions: ${width} x ${height}`;
    }
    result += `\nModified: ${stat.mtime.toISOString()}`;

    if (args.base64) {
      try {
        const content = fs.readFileSync(filePath);
        const b64 = content.toString('base64');
        if (b64.length > 50_000) {
          result += '\n\nBase64: (too large — over 50KB encoded)';
        } else {
          result += `\n\nBase64:\n${b64}`;
        }
      } catch {
        result += '\n\nBase64: Error reading file';
      }
    }

    return result;
  }

  private readJpegDimensions(filePath: string): { width: number; height: number } {
    try {
      const buf = fs.readFileSync(filePath);
      let offset = 2; // Skip SOI

      while (offset < buf.length - 1) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];

        // SOF markers (C0-C3, C5-C7, C9-CB, CD-CF)
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
            (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return { width, height };
        }

        // Skip non-SOF markers
        if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
        if (marker >= 0xD0 && marker <= 0xD7) { offset += 2; continue; }

        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    } catch { /* fallback */ }
    return { width: 0, height: 0 };
  }
}
