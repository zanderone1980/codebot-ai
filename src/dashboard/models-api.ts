/**
 * Model Management API — VRAM detection, local model listing, quantization recommendations.
 * Zero external dependencies.
 */

import { DashboardServer } from './server';
import { detectVRAM, recommendQuantization } from '../local-models';
import http from 'http';

/** Fetch JSON from a URL (simple GET, no deps) */
function fetchJSON(url: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export function registerModelRoutes(server: DashboardServer): void {

  // ── GET /api/models/vram ── Detect GPU/VRAM
  server.route('GET', '/api/models/vram', (_req, res) => {
    const vram = detectVRAM();
    DashboardServer.json(res, vram);
  });

  // ── GET /api/models/local ── List installed Ollama models
  server.route('GET', '/api/models/local', async (_req, res) => {
    try {
      const data = await fetchJSON('http://127.0.0.1:11434/api/tags');
      const models = (data.models || []).map((m: any) => ({
        name: m.name,
        size: m.size,
        sizeGB: m.size ? (m.size / (1024 * 1024 * 1024)).toFixed(1) + 'GB' : '?',
        modified: m.modified_at,
        digest: m.digest?.substring(0, 12),
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      }));
      DashboardServer.json(res, { models, count: models.length });
    } catch {
      DashboardServer.json(res, { models: [], count: 0, error: 'Ollama not running or unreachable' });
    }
  });

  // ── GET /api/models/recommend ── Quantization recommendation
  server.route('GET', '/api/models/recommend', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const model = url.searchParams.get('model') || '';
    if (!model) { DashboardServer.error(res, 400, 'Missing model parameter'); return; }
    const vram = detectVRAM();
    const rec = recommendQuantization(model, vram.totalMB);
    DashboardServer.json(res, { ...rec, vram });
  });

  // ── GET /api/models/status ── Combined status
  server.route('GET', '/api/models/status', async (_req, res) => {
    const vram = detectVRAM();
    let ollamaOnline = false;
    let modelCount = 0;
    try {
      const data = await fetchJSON('http://127.0.0.1:11434/api/tags');
      ollamaOnline = true;
      modelCount = (data.models || []).length;
    } catch { /* offline */ }
    DashboardServer.json(res, { vram, ollamaOnline, modelCount });
  });
}
