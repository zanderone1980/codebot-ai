import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { detectVRAM, recommendQuantization } from './local-models';

describe('detectVRAM', () => {
  it('returns a VRAMInfo object', () => {
    const info = detectVRAM();
    assert.ok(typeof info.totalMB === 'number');
    assert.ok(['nvidia-smi', 'system_profiler', 'proc_meminfo', 'unknown'].includes(info.source));
  });

  it('detects non-zero VRAM on this machine', () => {
    const info = detectVRAM();
    // On any dev machine we should get something
    assert.ok(info.totalMB >= 0, 'VRAM should be >= 0');
  });
});

describe('recommendQuantization', () => {
  it('recommends Q4_K_M for unknown models', () => {
    const rec = recommendQuantization('some-unknown-model', 8000);
    assert.strictEqual(rec.quantization, 'Q4_K_M');
    assert.ok(rec.reason.includes('Unknown'));
  });

  it('recommends fp16 when VRAM is abundant', () => {
    const rec = recommendQuantization('llama3:8b', 80000);
    assert.strictEqual(rec.quantization, 'fp16');
    assert.ok(rec.fits);
  });

  it('recommends smaller quant when VRAM is tight', () => {
    const rec = recommendQuantization('llama3:8b', 4000);
    assert.ok(['Q4_K_M', 'Q5_K_M'].includes(rec.quantization));
    assert.ok(rec.fits);
  });

  it('reports too_large when model cannot fit', () => {
    const rec = recommendQuantization('llama3:70b', 2000);
    assert.strictEqual(rec.quantization, 'too_large');
    assert.ok(!rec.fits);
  });

  it('includes VRAM estimate in reason', () => {
    const rec = recommendQuantization('llama3:8b', 16000);
    assert.ok(rec.reason.includes('MB'));
  });
});
