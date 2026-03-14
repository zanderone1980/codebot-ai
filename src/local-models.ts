/**
 * Local Model Utilities — VRAM detection and quantization recommendations.
 * Zero external dependencies.
 */

import { execSync } from 'child_process';

export interface VRAMInfo {
  totalMB: number;
  source: 'nvidia-smi' | 'system_profiler' | 'proc_meminfo' | 'unknown';
  gpu?: string;
}

/** Detect available VRAM (GPU memory) on the current system */
export function detectVRAM(): VRAMInfo {
  // Try NVIDIA GPU first
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const [mem, name] = out.split(',').map(s => s.trim());
    const totalMB = parseInt(mem, 10);
    if (!isNaN(totalMB) && totalMB > 0) {
      return { totalMB, source: 'nvidia-smi', gpu: name };
    }
  } catch { /* not NVIDIA or nvidia-smi not installed */ }

  // Try macOS Apple Silicon (unified memory)
  try {
    const out = execSync('system_profiler SPHardwareDataType 2>/dev/null | grep "Memory"', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const match = out.match(/(\d+)\s*GB/);
    if (match) {
      const totalGB = parseInt(match[1], 10);
      // Apple Silicon shares RAM as VRAM — roughly 75% available for GPU
      return { totalMB: Math.round(totalGB * 1024 * 0.75), source: 'system_profiler', gpu: 'Apple Silicon (unified)' };
    }
  } catch { /* not macOS */ }

  // Try Linux /proc/meminfo as fallback (for iGPU systems)
  try {
    const out = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = out.match(/MemTotal:\s*(\d+)\s*kB/);
    if (match) {
      const totalMB = Math.round(parseInt(match[1], 10) / 1024);
      // Shared memory systems — assume ~25% usable as VRAM
      return { totalMB: Math.round(totalMB * 0.25), source: 'proc_meminfo' };
    }
  } catch { /* not Linux or no access */ }

  return { totalMB: 0, source: 'unknown' };
}

export type QuantLevel = 'Q4_K_M' | 'Q5_K_M' | 'Q8_0' | 'fp16' | 'too_large';

export interface QuantRecommendation {
  quantization: QuantLevel;
  estimatedVRAM_MB: number;
  fits: boolean;
  reason: string;
}

/** Known model parameter counts (in billions) */
const MODEL_SIZES: Record<string, number> = {
  'llama3:8b': 8, 'llama3:70b': 70, 'llama3.1:8b': 8, 'llama3.1:70b': 70,
  'codellama:7b': 7, 'codellama:13b': 13, 'codellama:34b': 34,
  'mistral:7b': 7, 'mixtral:8x7b': 47, 'mixtral:8x22b': 141,
  'qwen2:7b': 7, 'qwen2:72b': 72, 'qwen3:14b': 14, 'qwen3:32b': 32,
  'deepseek-coder:6.7b': 6.7, 'deepseek-coder:33b': 33,
  'phi3:3.8b': 3.8, 'phi3:14b': 14, 'gemma2:9b': 9, 'gemma2:27b': 27,
  'command-r:35b': 35, 'command-r-plus:104b': 104,
};

/** Estimate VRAM needed for a model at a given quantization */
function estimateVRAM(paramsBillion: number, quant: QuantLevel): number {
  const bitsPerParam: Record<QuantLevel, number> = {
    'Q4_K_M': 4.5, 'Q5_K_M': 5.5, 'Q8_0': 8, 'fp16': 16, 'too_large': 16,
  };
  const bits = bitsPerParam[quant] || 16;
  // VRAM ≈ params * bits/8 + 500MB overhead (KV cache, runtime)
  return Math.round((paramsBillion * 1e9 * bits / 8) / (1024 * 1024) + 500);
}

/** Recommend best quantization for a model given available VRAM */
export function recommendQuantization(model: string, vramMB: number): QuantRecommendation {
  // Try to find param count
  const key = Object.keys(MODEL_SIZES).find(k => model.toLowerCase().includes(k.split(':')[0]) && model.includes(k.split(':')[1] || ''));
  const params = key ? MODEL_SIZES[key] : null;

  if (!params) {
    return { quantization: 'Q4_K_M', estimatedVRAM_MB: 0, fits: true, reason: 'Unknown model — defaulting to Q4_K_M (most compatible)' };
  }

  // Try each quant level from best to most compressed
  const levels: QuantLevel[] = ['fp16', 'Q8_0', 'Q5_K_M', 'Q4_K_M'];
  for (const level of levels) {
    const est = estimateVRAM(params, level);
    if (est <= vramMB) {
      return { quantization: level, estimatedVRAM_MB: est, fits: true, reason: `${params}B params @ ${level} needs ~${est}MB, you have ${vramMB}MB` };
    }
  }

  const minEst = estimateVRAM(params, 'Q4_K_M');
  return { quantization: 'too_large', estimatedVRAM_MB: minEst, fits: false, reason: `${params}B params needs at least ~${minEst}MB even at Q4_K_M, you have ${vramMB}MB` };
}
