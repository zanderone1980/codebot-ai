/**
 * Replicate Connector — image generation / upscaling / background removal.
 *
 * Auth: REPLICATE_API_TOKEN.
 *
 * §8 Connector Contract (PR 24)
 * -----------------------------
 * Four actions. One read + three writes. The three writes ALL carry
 * `spend-money`: every Replicate prediction is metered per second of
 * compute on the model's GPU. Per §7, spend-money tools are always-
 * ask, every call, and require a preview that names the cost surface.
 * Per §2, this is the "purchases / checkout" class: agent never holds
 * payment credentials directly; user clicks Approve per transaction.
 *
 *   list_models       — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   generate          — write  ['account-access', 'net-fetch', 'spend-money', 'write-fs']
 *   upscale           — write  ['account-access', 'net-fetch', 'spend-money', 'write-fs']
 *   remove_background — write  ['account-access', 'net-fetch', 'spend-money', 'write-fs']
 *
 *   write-fs is on every paid verb because the connector downloads
 *   the result image to a local file as part of a successful run.
 *   Clean failure modes: download error after a successful generation
 *   means we BILLED but did not deliver. The connector reports this
 *   honestly rather than silently swallowing.
 *
 * Idempotency
 * -----------
 * All three paid verbs declare `kind: 'unsupported'`. Replicate's
 * POST /predictions does not accept any client-supplied idempotency
 * key. The `Prefer: wait` and `Prefer: respond-async` headers control
 * sync vs. async response, NOT dedup. Two POSTs with the same body
 * create two distinct predictions and bill twice.
 *
 * Reauth detection (`isReplicateAuthError`)
 * -----------------------------------------
 *   - HTTP 401 → always reauth.
 *   - HTTP 402 → NOT reauth (Payment Required: the account is out of
 *     credits or the card was declined; reconnecting won't help).
 *   - HTTP 429 → never reauth.
 *   - Anything else → NOT reauth.
 *
 * `vaultKeyName: 'replicate'` declared explicitly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const BASE_URL = 'https://api.replicate.com/v1';
const TIMEOUT = 120_000;
const POLL_INTERVAL = 2_000;
const MAX_POLL_TIME = 300_000;

function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface ReplicateApiError {
  detail?: string;
  title?: string;
  type?: string;
  status?: number;
}

export function isReplicateAuthError(status: number, _body: ReplicateApiError | undefined): boolean {
  if (status === 401) return true;
  // 402 = Payment Required: out of credits, card declined. NOT reauth.
  // 429 = Rate limit. NOT reauth.
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function apiRequest(
  method: string,
  endpoint: string,
  credential: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${credential}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${endpoint}`, opts);
    clearTimeout(timer);
    let data: unknown = {};
    if (res.status !== 204) {
      try { data = await res.json(); } catch { data = {}; }
    }
    if (isReplicateAuthError(res.status, data as ReplicateApiError)) {
      throw new ConnectorReauthError('replicate', `Replicate auth failed: HTTP ${res.status}`);
    }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

async function pollPrediction(
  id: string,
  credential: string,
): Promise<{ id: string; status: string; output: unknown; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_TIME) {
    const { data } = await apiRequest('GET', `/predictions/${id}`, credential);
    const pred = data as { id: string; status: string; output: unknown; error?: string };
    if (pred.status === 'succeeded' || pred.status === 'failed' || pred.status === 'canceled') {
      return pred;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
  return { id, status: 'timeout', output: null, error: 'Prediction timed out' };
}

async function downloadImage(url: string, outputDir: string, prefix: string): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = url.match(/\.(png|jpg|jpeg|webp|gif)/i)?.[1] || 'png';
    const filename = `${prefix}-${Date.now()}.${ext}`;
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

const MODEL_SHORTCUTS: Record<string, string> = {
  'flux-pro': 'black-forest-labs/flux-1.1-pro',
  'flux-schnell': 'black-forest-labs/flux-schnell',
  'flux': 'black-forest-labs/flux-1.1-pro',
  'sdxl': 'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
  'sdxl-lightning': 'bytedance/sdxl-lightning-4step:5f24084160c9089501c1b3545d9be3c27883ae2239b6f412990e82d4a6210f8f',
  'sd3': 'stability-ai/stable-diffusion-3',
};

// ─── Idempotency declaration constants ────────────────────────────────────

const PAID_VERB_IDEMPOTENCY_REASON =
  'Replicate POST /predictions does not accept any client-supplied idempotency key. The `Prefer: wait` / `Prefer: respond-async` headers control sync vs. async response, not dedup. Two POSTs with the same body create two distinct predictions and bill twice. The connector does NOT preflight-dedup.';

// ─── Redaction helpers (mutating verbs) ───────────────────────────────────

function redactGenerateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  // Hash prompt + negative_prompt — they may contain creative IP /
  // brand-sensitive text that shouldn't sit raw in the audit.
  if (typeof args.prompt === 'string' && args.prompt.length > 0) {
    const d = hashAndLength(args.prompt);
    out.prompt = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  if (typeof args.negative_prompt === 'string' && args.negative_prompt.length > 0) {
    const d = hashAndLength(args.negative_prompt);
    out.negative_prompt = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

function redactImageArgs(args: Record<string, unknown>): Record<string, unknown> {
  // upscale + remove_background take a local image PATH. The path
  // itself is fine to keep in the audit — it's metadata, not the
  // image content. No redaction needed; declare identity per
  // contract requirement.
  return { ...args };
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewGenerate(args: Record<string, unknown>): ConnectorPreview {
  const prompt = String(args.prompt ?? '');
  const modelKey = (typeof args.model === 'string' && args.model.length > 0) ? args.model : 'flux-schnell';
  const modelId = MODEL_SHORTCUTS[modelKey] || modelKey;
  const negativePrompt = typeof args.negative_prompt === 'string' ? args.negative_prompt : '';
  const width = typeof args.width === 'number' ? args.width : 1024;
  const height = typeof args.height === 'number' ? args.height : 1024;
  const numOutputs = typeof args.num_outputs === 'number' ? args.num_outputs : 1;
  const outputDir = (typeof args.output_dir === 'string' && args.output_dir.length > 0) ? args.output_dir : process.cwd();
  const promptDigest = prompt.length > 0 ? hashAndLength(prompt) : null;
  const negDigest = negativePrompt.length > 0 ? hashAndLength(negativePrompt) : null;

  const lines = [
    `Would generate image(s) on Replicate (PAID):`,
    `  Model:           ${modelKey} (${modelId})`,
    `  Prompt:          ${prompt}`,
    promptDigest ? `  Prompt hash:     sha256:${promptDigest.hash} len:${promptDigest.length}` : '',
    negativePrompt ? `  Negative:        ${negativePrompt}` : '',
    negDigest ? `  Negative hash:   sha256:${negDigest.hash} len:${negDigest.length}` : '',
    `  Size:            ${width}x${height}`,
    `  Outputs:         ${numOutputs}`,
    `  Save to:         ${outputDir}`,
    `  💰 Cost:         BILLED per second of GPU compute on Replicate. Exact cost varies by model — see replicate.com/${modelId}.`,
    `  Idempotency:     NONE — retrying after a partial failure bills again.`,
  ].filter(Boolean);
  return {
    summary: lines.join('\n'),
    details: {
      model: modelKey,
      modelId,
      width, height, numOutputs,
      outputDir,
      promptLength: promptDigest?.length ?? 0,
      promptHash: promptDigest?.hash ?? null,
      hasNegative: negativePrompt.length > 0,
    },
  };
}

function previewUpscale(args: Record<string, unknown>): ConnectorPreview {
  const imagePath = String(args.image ?? '');
  const scale = typeof args.scale === 'number' ? args.scale : 2;
  const outputDir = (typeof args.output_dir === 'string' && args.output_dir.length > 0) ? args.output_dir : path.dirname(imagePath || '.');

  const lines = [
    `Would upscale image on Replicate (PAID):`,
    `  Image:       ${imagePath}`,
    `  Scale:       ${scale}x`,
    `  Save to:     ${outputDir}`,
    `  Model:       nightmareai/real-esrgan`,
    `  💰 Cost:     BILLED per second of GPU compute. Real-ESRGAN is typically a few cents per image.`,
    `  Idempotency: NONE — retrying after a partial failure bills again.`,
  ];
  return {
    summary: lines.join('\n'),
    details: { imagePath, scale, outputDir, model: 'nightmareai/real-esrgan' },
  };
}

function previewRemoveBackground(args: Record<string, unknown>): ConnectorPreview {
  const imagePath = String(args.image ?? '');
  const outputDir = (typeof args.output_dir === 'string' && args.output_dir.length > 0) ? args.output_dir : path.dirname(imagePath || '.');

  return {
    summary: [
      `Would remove background on Replicate (PAID):`,
      `  Image:       ${imagePath}`,
      `  Save to:     ${outputDir}`,
      `  Model:       cjwbw/rembg`,
      `  💰 Cost:     BILLED per second of GPU compute. rembg is typically a few cents per image.`,
      `  Idempotency: NONE — retrying after a partial failure bills again.`,
    ].join('\n'),
    details: { imagePath, outputDir, model: 'cjwbw/rembg' },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const generate: ConnectorAction = {
  name: 'generate',
  description: 'Generate an image using a Replicate model (Flux, SDXL, etc.). PAID — billed per second of GPU compute.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      model: { type: 'string', description: 'Model: flux-pro, flux-schnell, sdxl, sdxl-lightning, sd3, or full model ID (default: flux-schnell)' },
      negative_prompt: { type: 'string', description: 'What to avoid in the image' },
      width: { type: 'number', description: 'Image width (default: 1024)' },
      height: { type: 'number', description: 'Image height (default: 1024)' },
      num_outputs: { type: 'number', description: 'Number of images to generate (default: 1)' },
      guidance_scale: { type: 'number', description: 'How closely to follow the prompt (default varies by model)' },
      num_inference_steps: { type: 'number', description: 'Number of denoising steps (more = better quality, slower)' },
      seed: { type: 'number', description: 'Random seed for reproducibility' },
      output_dir: { type: 'string', description: 'Directory to save images (default: current directory)' },
    },
    required: ['prompt'],
  },
  capabilities: ['account-access', 'net-fetch', 'spend-money', 'write-fs'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewGenerate(args),
  redactArgsForAudit: redactGenerateArgs,
  idempotency: { kind: 'unsupported', reason: PAID_VERB_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const prompt = args.prompt as string;
    if (!prompt) return 'Error: prompt is required';
    const modelKey = (args.model as string) || 'flux-schnell';
    const modelId = MODEL_SHORTCUTS[modelKey] || modelKey;
    const outputDir = (args.output_dir as string) || process.cwd();
    const input: Record<string, unknown> = { prompt };
    if (args.negative_prompt) input.negative_prompt = args.negative_prompt;
    if (args.width) input.width = args.width;
    if (args.height) input.height = args.height;
    if (args.num_outputs) input.num_outputs = args.num_outputs;
    if (args.guidance_scale) input.guidance_scale = args.guidance_scale;
    if (args.num_inference_steps) input.num_inference_steps = args.num_inference_steps;
    if (args.seed) input.seed = args.seed;

    try {
      let endpoint: string;
      let body: Record<string, unknown>;
      if (modelId.includes(':')) {
        const [, version] = modelId.split(':');
        endpoint = '/predictions';
        body = { version, input };
      } else {
        endpoint = `/models/${modelId}/predictions`;
        body = { input };
      }
      const { status, data } = await apiRequest('POST', endpoint, cred, body);
      if (status === 201 || status === 200) {
        let pred = data as { id: string; status: string; output: unknown; error?: string };
        if (pred.status !== 'succeeded') pred = await pollPrediction(pred.id, cred);
        if (pred.status === 'failed') return `Error: Generation failed: ${pred.error || 'unknown error'}`;
        if (pred.status !== 'succeeded') return `Error: Generation ${pred.status}`;
        const output = pred.output;
        const urls: string[] = Array.isArray(output) ? output as string[] : typeof output === 'string' ? [output] : [];
        if (!urls.length) return 'Error: no images in output';
        const saved: string[] = [];
        for (const url of urls) {
          if (typeof url === 'string' && url.startsWith('http')) {
            try {
              const filePath = await downloadImage(url, outputDir, 'replicate');
              saved.push(filePath);
            } catch (downloadErr) {
              // We BILLED but didn't deliver. Report honestly.
              return `Error: Generation succeeded (BILLED) but download failed: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}. Output URL: ${url}`;
            }
          }
        }
        return `Generated ${saved.length} image(s) with ${modelKey}:\n${saved.map(p => `  ${p}`).join('\n')}`;
      }
      const errData = data as { detail?: string; error?: string };
      return `Error: Replicate API ${status}: ${errData.detail || errData.error || JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listModels: ConnectorAction = {
  name: 'list_models',
  description: 'List popular image generation models available on Replicate',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "image generation", "upscale")' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const builtIn = [
      '  flux-pro         - black-forest-labs/flux-1.1-pro (best quality, ~10s)',
      '  flux-schnell     - black-forest-labs/flux-schnell (fast, ~2s)',
      '  sdxl             - stability-ai/sdxl (classic SD)',
      '  sdxl-lightning   - bytedance/sdxl-lightning-4step (very fast)',
      '  sd3              - stability-ai/stable-diffusion-3',
    ];
    let result = `Image Generation Models (shortcuts):\n${builtIn.join('\n')}`;
    const query = args.query as string;
    if (query) {
      try {
        const { status, data } = await apiRequest('GET', `/models?query=${encodeURIComponent(query)}`, cred);
        if (status === 200) {
          const models = (data as { results: Array<{ owner: string; name: string; description: string; run_count: number }> }).results || [];
          if (models.length) {
            const lines = models.slice(0, 10).map(m =>
              `  ${m.owner}/${m.name} - ${(m.description || '').substring(0, 60)} (${m.run_count} runs)`
            );
            result += `\n\nSearch results for "${query}":\n${lines.join('\n')}`;
          }
        }
      } catch (err) {
        if (err instanceof ConnectorReauthError) throw err;
        /* search failed, still return built-in list */
      }
    }
    return result;
  },
};

const upscale: ConnectorAction = {
  name: 'upscale',
  description: 'Upscale an image to higher resolution. PAID — billed per second of GPU compute.',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Path to the image to upscale' },
      scale: { type: 'number', description: 'Upscale factor: 2 or 4 (default: 2)' },
      output_dir: { type: 'string', description: 'Directory to save the result' },
    },
    required: ['image'],
  },
  capabilities: ['account-access', 'net-fetch', 'spend-money', 'write-fs'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewUpscale(args),
  redactArgsForAudit: redactImageArgs,
  idempotency: { kind: 'unsupported', reason: PAID_VERB_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const imagePath = args.image as string;
    if (!imagePath) return 'Error: image path is required';
    if (!fs.existsSync(imagePath)) return `Error: image not found: ${imagePath}`;
    const scale = (args.scale as number) || 2;
    const outputDir = (args.output_dir as string) || path.dirname(imagePath);
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).slice(1) || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      const { status, data } = await apiRequest('POST', '/models/nightmareai/real-esrgan/predictions', cred, {
        input: { image: dataUri, scale, face_enhance: false },
      });
      if (status !== 201 && status !== 200) {
        const errData = data as { detail?: string };
        return `Error: Replicate API ${status}: ${errData.detail || 'unknown'}`;
      }
      let pred = data as { id: string; status: string; output: unknown; error?: string };
      if (pred.status !== 'succeeded') pred = await pollPrediction(pred.id, cred);
      if (pred.status !== 'succeeded') return `Error: Upscale ${pred.status}: ${pred.error || 'unknown'}`;
      const outputUrl = typeof pred.output === 'string' ? pred.output : '';
      if (!outputUrl) return 'Error: no output from upscale model';
      try {
        const filePath = await downloadImage(outputUrl, outputDir, 'upscaled');
        return `Image upscaled ${scale}x and saved to: ${filePath}`;
      } catch (dlErr) {
        return `Error: Upscale succeeded (BILLED) but download failed: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}. Output URL: ${outputUrl}`;
      }
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const removeBackground: ConnectorAction = {
  name: 'remove_background',
  description: 'Remove the background from an image. PAID — billed per second of GPU compute.',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Path to the image' },
      output_dir: { type: 'string', description: 'Directory to save the result' },
    },
    required: ['image'],
  },
  capabilities: ['account-access', 'net-fetch', 'spend-money', 'write-fs'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewRemoveBackground(args),
  redactArgsForAudit: redactImageArgs,
  idempotency: { kind: 'unsupported', reason: PAID_VERB_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const imagePath = args.image as string;
    if (!imagePath) return 'Error: image path is required';
    if (!fs.existsSync(imagePath)) return `Error: image not found: ${imagePath}`;
    const outputDir = (args.output_dir as string) || path.dirname(imagePath);
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).slice(1) || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      const { status, data } = await apiRequest('POST', '/models/cjwbw/rembg/predictions', cred, {
        input: { image: dataUri },
      });
      if (status !== 201 && status !== 200) {
        const errData = data as { detail?: string };
        return `Error: Replicate API ${status}: ${errData.detail || 'unknown'}`;
      }
      let pred = data as { id: string; status: string; output: unknown; error?: string };
      if (pred.status !== 'succeeded') pred = await pollPrediction(pred.id, cred);
      if (pred.status !== 'succeeded') return `Error: Background removal ${pred.status}: ${pred.error || 'unknown'}`;
      const outputUrl = typeof pred.output === 'string' ? pred.output : '';
      if (!outputUrl) return 'Error: no output from model';
      try {
        const filePath = await downloadImage(outputUrl, outputDir, 'nobg');
        return `Background removed and saved to: ${filePath}`;
      } catch (dlErr) {
        return `Error: Background removal succeeded (BILLED) but download failed: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}. Output URL: ${outputUrl}`;
      }
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class ReplicateConnector implements Connector {
  name = 'replicate';
  displayName = 'Replicate';
  description = 'Generate images with Flux, Stable Diffusion, and hundreds of other AI models via Replicate.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'REPLICATE_API_TOKEN';
  vaultKeyName = 'replicate';

  actions: ConnectorAction[] = [generate, listModels, upscale, removeBackground];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await apiRequest('GET', '/account', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
