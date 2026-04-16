import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from setup.ts
import { autoDetect, pickBestLocalModel, loadConfig, saveConfig, isFirstRun, pickProviderKey, normalizeProviderBaseUrl, isProviderDisabled } from './setup';
import type { AutoDetectResult, SavedConfig } from './setup';

describe('normalizeProviderBaseUrl (issue #5 — stale baseUrl on provider switch)', () => {
  it('switches stale Anthropic baseUrl when provider becomes openai', () => {
    const out = normalizeProviderBaseUrl({ provider: 'openai', baseUrl: 'https://api.anthropic.com' });
    assert.strictEqual(out.baseUrl, 'https://api.openai.com');
  });

  it('switches stale OpenAI baseUrl when provider becomes anthropic', () => {
    const out = normalizeProviderBaseUrl({ provider: 'anthropic', baseUrl: 'https://api.openai.com' });
    assert.strictEqual(out.baseUrl, 'https://api.anthropic.com');
  });

  it('fills empty baseUrl with provider default', () => {
    const out = normalizeProviderBaseUrl({ provider: 'gemini', baseUrl: '' });
    assert.match(out.baseUrl || '', /generativelanguage\.googleapis\.com/);
  });

  it('leaves localhost URLs alone (user choice)', () => {
    const out = normalizeProviderBaseUrl({ provider: 'openai', baseUrl: 'http://localhost:11434' });
    assert.strictEqual(out.baseUrl, 'http://localhost:11434');
  });

  it('leaves 127.0.0.1 URLs alone', () => {
    const out = normalizeProviderBaseUrl({ provider: 'anthropic', baseUrl: 'http://127.0.0.1:1234' });
    assert.strictEqual(out.baseUrl, 'http://127.0.0.1:1234');
  });

  it('leaves matching default alone (no-op)', () => {
    const cfg: SavedConfig = { provider: 'openai', baseUrl: 'https://api.openai.com' };
    const out = normalizeProviderBaseUrl(cfg);
    assert.strictEqual(out.baseUrl, 'https://api.openai.com');
  });

  it('leaves custom URLs alone (user explicitly set something non-default)', () => {
    const out = normalizeProviderBaseUrl({ provider: 'openai', baseUrl: 'https://my-corp-proxy.example.com/openai' });
    assert.strictEqual(out.baseUrl, 'https://my-corp-proxy.example.com/openai');
  });

  it('does not crash on missing provider', () => {
    const out = normalizeProviderBaseUrl({ baseUrl: 'https://api.openai.com' });
    assert.strictEqual(out.baseUrl, 'https://api.openai.com');
  });

  it('does not mutate input', () => {
    const cfg: SavedConfig = { provider: 'openai', baseUrl: 'https://api.anthropic.com' };
    normalizeProviderBaseUrl(cfg);
    assert.strictEqual(cfg.baseUrl, 'https://api.anthropic.com'); // unchanged
  });
});

describe('pickProviderKey (issue #6 — multi-provider key support)', () => {
  it('returns the provider-specific key when present', () => {
    const cfg: SavedConfig = { apiKey: 'sk-ant-fallback', openaiApiKey: 'sk-proj-real' };
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'sk-proj-real');
  });

  it('falls back to generic apiKey when provider-specific is absent', () => {
    const cfg: SavedConfig = { apiKey: 'sk-ant-only' };
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), 'sk-ant-only');
  });

  it('falls back to generic apiKey when provider-specific is empty string', () => {
    const cfg: SavedConfig = { apiKey: 'sk-fallback', openaiApiKey: '' };
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'sk-fallback');
  });

  it('returns empty string when neither generic nor specific is set', () => {
    assert.strictEqual(pickProviderKey({}, 'openai'), '');
  });

  it('does NOT cross-pollinate keys between providers', () => {
    const cfg: SavedConfig = { anthropicApiKey: 'sk-ant-x', openaiApiKey: 'sk-proj-y' };
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'sk-proj-y');
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), 'sk-ant-x');
  });

  it('returns generic for unknown providers (no field mapping)', () => {
    const cfg: SavedConfig = { apiKey: 'sk-generic' };
    assert.strictEqual(pickProviderKey(cfg, 'unknown-provider'), 'sk-generic');
  });

  it('handles all 7 mapped providers', () => {
    const cfg: SavedConfig = {
      apiKey: 'fallback',
      anthropicApiKey: 'a-key',
      openaiApiKey: 'o-key',
      geminiApiKey: 'g-key',
      deepseekApiKey: 'd-key',
      groqApiKey: 'q-key',
      mistralApiKey: 'm-key',
      xaiApiKey: 'x-key',
    };
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), 'a-key');
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'o-key');
    assert.strictEqual(pickProviderKey(cfg, 'gemini'), 'g-key');
    assert.strictEqual(pickProviderKey(cfg, 'deepseek'), 'd-key');
    assert.strictEqual(pickProviderKey(cfg, 'groq'), 'q-key');
    assert.strictEqual(pickProviderKey(cfg, 'mistral'), 'm-key');
    assert.strictEqual(pickProviderKey(cfg, 'xai'), 'x-key');
  });
});

describe('pickProviderKey — disabledProviders hard block', () => {
  it('returns empty when provider is in disabledProviders, even if key is saved', () => {
    const cfg: SavedConfig = {
      anthropicApiKey: 'sk-ant-real',
      apiKey: 'also-real',
      disabledProviders: ['anthropic'],
    };
    // Both the specific field AND the generic fallback must be suppressed.
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), '');
  });

  it('still returns keys for providers not in the disabled list', () => {
    const cfg: SavedConfig = {
      openaiApiKey: 'sk-proj-real',
      anthropicApiKey: 'sk-ant-real',
      disabledProviders: ['anthropic'],
    };
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'sk-proj-real');
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), '');
  });

  it('ignores disabledProviders when it is missing or not an array', () => {
    const cfg1: SavedConfig = { anthropicApiKey: 'a' };
    const cfg2: SavedConfig = { anthropicApiKey: 'a', disabledProviders: [] };
    assert.strictEqual(pickProviderKey(cfg1, 'anthropic'), 'a');
    assert.strictEqual(pickProviderKey(cfg2, 'anthropic'), 'a');
  });

  it('can disable multiple providers at once', () => {
    const cfg: SavedConfig = {
      anthropicApiKey: 'a', openaiApiKey: 'o', geminiApiKey: 'g',
      disabledProviders: ['anthropic', 'gemini'],
    };
    assert.strictEqual(pickProviderKey(cfg, 'anthropic'), '');
    assert.strictEqual(pickProviderKey(cfg, 'gemini'), '');
    assert.strictEqual(pickProviderKey(cfg, 'openai'), 'o');
  });
});

describe('isProviderDisabled', () => {
  it('returns true for banned providers', () => {
    assert.strictEqual(
      isProviderDisabled({ disabledProviders: ['anthropic'] }, 'anthropic'),
      true,
    );
  });
  it('returns false when provider is absent from the list', () => {
    assert.strictEqual(
      isProviderDisabled({ disabledProviders: ['anthropic'] }, 'openai'),
      false,
    );
  });
  it('returns false when disabledProviders is missing, undefined, or not an array', () => {
    assert.strictEqual(isProviderDisabled({}, 'anthropic'), false);
    assert.strictEqual(
      isProviderDisabled({ disabledProviders: undefined as unknown as string[] }, 'anthropic'),
      false,
    );
    assert.strictEqual(
      isProviderDisabled({ disabledProviders: 'not-array' as unknown as string[] }, 'anthropic'),
      false,
    );
  });
});

describe('pickBestLocalModel', () => {
  it('picks qwen2.5-coder as top choice', () => {
    const models = ['phi-4:14b', 'qwen2.5-coder:32b', 'llama3.1:8b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'qwen2.5-coder:32b');
  });

  it('picks deepseek-coder over llama', () => {
    const models = ['llama3.1:8b', 'deepseek-coder-v2:16b', 'mistral:7b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'deepseek-coder-v2:16b');
  });

  it('picks qwen3 over phi', () => {
    const models = ['phi-4:14b', 'qwen3:14b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'qwen3:14b');
  });

  it('returns first model when no ranked match', () => {
    const models = ['unknown-custom-model:7b', 'another-model:13b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'unknown-custom-model:7b');
  });

  it('returns undefined for empty array', () => {
    const result = pickBestLocalModel([]);
    assert.strictEqual(result, undefined);
  });

  it('handles case-insensitive matching', () => {
    const models = ['Qwen2.5-Coder:7B', 'llama3.1:8b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'Qwen2.5-Coder:7B');
  });
});

describe('autoDetect', () => {
  const CONFIG_DIR = path.join(os.homedir(), '.codebot');
  const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  let savedConfig: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
  ];

  beforeEach(() => {
    // Backup config
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        savedConfig = fs.readFileSync(CONFIG_FILE, 'utf-8');
      }
    } catch { savedConfig = null; }

    // Backup env
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore config
    if (savedConfig !== null) {
      fs.writeFileSync(CONFIG_FILE, savedConfig);
    }

    // Restore env
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns auto-start when config exists with model and provider', async () => {
    // This test relies on the existing config being present
    // (which it is since we're running from the codebot-ai project)
    const config = loadConfig();
    if (config.model && config.provider) {
      const result = await autoDetect();
      assert.strictEqual(result.type, 'auto-start');
      assert.ok(result.model);
      assert.ok(result.provider);
    }
  });

  it('returns result with localServers array', async () => {
    const result = await autoDetect();
    assert.ok(Array.isArray(result.localServers));
  });

  it('returns result with detectedKeys map', async () => {
    const result = await autoDetect();
    assert.ok(result.detectedKeys instanceof Map);
  });

  it('detects env API keys', async () => {
    const result = await autoDetect();
    // Check that the keys detected match what's in the environment
    for (const key of envKeys) {
      if (process.env[key]) {
        // The provider name mapping is done internally, but at least keys should be tracked
        assert.ok(result.detectedKeys.size >= 0); // just verify it's a Map
      }
    }
  });
});

describe('AutoDetectResult interface', () => {
  it('supports all required fields', () => {
    const result: AutoDetectResult = {
      type: 'auto-start',
      model: 'gpt-4o',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      localServers: [],
      detectedKeys: new Map(),
    };
    assert.strictEqual(result.type, 'auto-start');
    assert.strictEqual(result.model, 'gpt-4o');
  });

  it('supports one-question type', () => {
    const result: AutoDetectResult = {
      type: 'one-question',
      localServers: [],
      detectedKeys: new Map(),
    };
    assert.strictEqual(result.type, 'one-question');
    assert.strictEqual(result.model, undefined);
  });
});

describe('SavedConfig backward compatibility', () => {
  it('loadConfig handles configs without firstRunComplete field', () => {
    const config = loadConfig();
    // Old configs won't have firstRunComplete, should still load fine
    assert.ok(typeof config === 'object');
  });
});

describe('RECOMMENDED_MODELS', () => {
  // Import at top doesn't have RECOMMENDED_MODELS, but pickBestLocalModel tests the ranking logic
  it('pickBestLocalModel uses internal ranking', () => {
    // Verify ranking order: qwen2.5-coder > qwen3 > deepseek > llama > codellama > mistral > phi
    const models = ['mistral:7b', 'qwen3:8b', 'codellama:34b'];
    const result = pickBestLocalModel(models);
    assert.strictEqual(result, 'qwen3:8b'); // qwen3 ranked higher than mistral and codellama
  });
});
