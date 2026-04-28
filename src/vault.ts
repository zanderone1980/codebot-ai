/**
 * Credential Vault for CodeBot v2.5.0
 *
 * Encrypted credential storage for app connectors.
 * Reuses AES-256-GCM encryption from encryption.ts.
 *
 * Storage: ~/.codebot/vault.json (single encrypted blob, base64 on disk)
 * Passphrase priority: CODEBOT_VAULT_KEY → CODEBOT_ENCRYPTION_KEY → machine-derived
 *
 * NEVER throws — returns empty/undefined on failure (matches encryption.ts philosophy).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { encrypt, decrypt } from './encryption';
import { codebotHome, codebotPath } from './paths';
import { warnNonFatal } from './warn';



export interface VaultCredential {
  name: string;
  type: 'api_key' | 'oauth_token' | 'webhook_url';
  value: string;
  metadata: {
    provider: string;
    scope?: string;
    expires?: string;
    created: string;
  };
}

interface VaultData {
  version: 1;
  credentials: VaultCredential[];
}

/** Where did the passphrase come from? Exposed via status() so users
 * can actually see it rather than hope. */
export type VaultKeySource = 'env:CODEBOT_VAULT_KEY' | 'env:CODEBOT_ENCRYPTION_KEY' | 'machine-derived';

export interface VaultManagerOpts {
  /**
   * Override the on-disk vault location. Defaults to
   * `codebotPath('vault.json')` (i.e., `~/.codebot/vault.json`) when
   * unset. Tests must pass an isolated tempdir path here — see
   * `makeTestVaultPath()` in `src/test-vault-isolation.ts` — otherwise
   * the test run encrypts the user's real vault with the test
   * passphrase and leaves production credentials unreadable.
   */
  vaultPath?: string;
}

export class VaultManager {
  private passphrase: string;
  private keySource: VaultKeySource;
  private vaultPathOverride?: string;
  private static machineWarningShown = false;

  constructor(opts: VaultManagerOpts = {}) {
    const resolved = this.resolvePassphrase();
    this.passphrase = resolved.passphrase;
    this.keySource = resolved.source;
    this.vaultPathOverride = opts.vaultPath;
    this.maybeWarnMachineFallback();
  }

  /** Resolve the vault file path — explicit override beats default. */
  private vaultFile(): string {
    return this.vaultPathOverride ?? codebotPath('vault.json');
  }

  /** Resolve the directory the vault lives in (for mkdirSync on save). */
  private vaultDir(): string {
    if (this.vaultPathOverride) {
      const idx = this.vaultPathOverride.lastIndexOf('/');
      return idx > 0 ? this.vaultPathOverride.slice(0, idx) : codebotHome();
    }
    return codebotHome();
  }

  /**
   * Passphrase priority: env vars → machine-derived fallback.
   *
   * P2-2 fix: also returns the source so callers (tests, status,
   * diagnostics) can see where the key came from. The previous
   * implementation silently fell back to a machine-derived key and
   * there was no way to audit that from inside CodeBot.
   */
  private resolvePassphrase(): { passphrase: string; source: VaultKeySource } {
    if (process.env.CODEBOT_VAULT_KEY) {
      return { passphrase: process.env.CODEBOT_VAULT_KEY, source: 'env:CODEBOT_VAULT_KEY' };
    }
    if (process.env.CODEBOT_ENCRYPTION_KEY) {
      return { passphrase: process.env.CODEBOT_ENCRYPTION_KEY, source: 'env:CODEBOT_ENCRYPTION_KEY' };
    }
    const derived = crypto.createHash('sha256')
      .update(`${os.hostname()}:${os.userInfo().username}:${os.platform()}`)
      .digest('hex');
    return { passphrase: derived, source: 'machine-derived' };
  }

  /**
   * Print a one-time-per-process warning when we're using the
   * machine-derived fallback. Respects CODEBOT_VAULT_SILENT=1 for CI
   * and any caller that has already been notified (the static flag
   * covers multiple VaultManager instances in the same process).
   */
  private maybeWarnMachineFallback(): void {
    if (this.keySource !== 'machine-derived') return;
    if (VaultManager.machineWarningShown) return;
    if (process.env.CODEBOT_VAULT_SILENT === '1') return;
    VaultManager.machineWarningShown = true;
    warnNonFatal(
      'Vault',
      'using machine-derived passphrase (no CODEBOT_VAULT_KEY set). ' +
      'Credentials are encrypted but the key is derived from your hostname/username/platform, ' +
      'so they are NOT portable across machines and are recoverable by anyone with local read ' +
      'on ~/.codebot. For production or shared environments, set CODEBOT_VAULT_KEY to a secret ' +
      'you manage yourself. Silence this warning with CODEBOT_VAULT_SILENT=1.',
    );
  }

  /** Human-readable status for `codebot vault status` or diagnostics.
   *  Never includes the actual passphrase. */
  status(): { keySource: VaultKeySource; vaultPath: string; vaultExists: boolean; credentialCount: number } {
    const vaultPath = this.vaultFile();
    return {
      keySource: this.keySource,
      vaultPath,
      vaultExists: fs.existsSync(vaultPath),
      credentialCount: this.load().credentials.length,
    };
  }

  /** Reset the one-time warning flag (test hook). */
  static _resetWarning(): void { VaultManager.machineWarningShown = false; }

  /** Load and decrypt vault data. Returns empty vault on any failure. */
  private load(): VaultData {
    const empty: VaultData = { version: 1, credentials: [] };
    try {
      if (!fs.existsSync(this.vaultFile())) return empty;
      const raw = fs.readFileSync(this.vaultFile(), 'utf-8').trim();
      if (!raw) return empty;

      // Try decrypting
      const decrypted = decrypt(raw, this.passphrase);
      if (!decrypted) return empty;

      const data = JSON.parse(decrypted) as VaultData;
      if (!data.credentials || !Array.isArray(data.credentials)) return empty;
      return data;
    } catch {
      return empty;
    }
  }

  /** Encrypt and save vault data to disk. */
  private save(data: VaultData): void {
    try {
      fs.mkdirSync(this.vaultDir(), { recursive: true });
      const json = JSON.stringify(data, null, 2);
      const encrypted = encrypt(json, this.passphrase);
      if (encrypted) {
        fs.writeFileSync(this.vaultFile(), encrypted, 'utf-8');
      }
    } catch (err) { warnNonFatal('vault.save', err); }
  }

  /** Get a credential by name. Returns undefined if not found. */
  get(name: string): VaultCredential | undefined {
    const data = this.load();
    return data.credentials.find(c => c.name === name);
  }

  /** Save or update a credential. */
  set(name: string, credential: Omit<VaultCredential, 'name'>): void {
    const data = this.load();
    const idx = data.credentials.findIndex(c => c.name === name);
    const entry: VaultCredential = { name, ...credential };

    if (idx >= 0) {
      data.credentials[idx] = entry;
    } else {
      data.credentials.push(entry);
    }
    this.save(data);
  }

  /** Delete a credential. Returns true if it existed. */
  delete(name: string): boolean {
    const data = this.load();
    const idx = data.credentials.findIndex(c => c.name === name);
    if (idx < 0) return false;
    data.credentials.splice(idx, 1);
    this.save(data);
    return true;
  }

  /** List credential names only (never values). */
  list(): string[] {
    const data = this.load();
    return data.credentials.map(c => c.name);
  }

  /** Check if a credential exists. */
  has(name: string): boolean {
    const data = this.load();
    return data.credentials.some(c => c.name === name);
  }
}
