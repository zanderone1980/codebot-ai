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
import * as path from 'path';
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

export class VaultManager {
  private passphrase: string;

  constructor() {
    this.passphrase = this.resolvePassphrase();
  }

  /** Passphrase priority: env vars → machine-derived fallback */
  private resolvePassphrase(): string {
    if (process.env.CODEBOT_VAULT_KEY) return process.env.CODEBOT_VAULT_KEY;
    if (process.env.CODEBOT_ENCRYPTION_KEY) return process.env.CODEBOT_ENCRYPTION_KEY;

    // Machine-derived: deterministic per machine, not portable
    return crypto.createHash('sha256')
      .update(`${os.hostname()}:${os.userInfo().username}:${os.platform()}`)
      .digest('hex');
  }

  /** Load and decrypt vault data. Returns empty vault on any failure. */
  private load(): VaultData {
    const empty: VaultData = { version: 1, credentials: [] };
    try {
      if (!fs.existsSync(codebotPath('vault.json'))) return empty;
      const raw = fs.readFileSync(codebotPath('vault.json'), 'utf-8').trim();
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
      fs.mkdirSync(codebotHome(), { recursive: true });
      const json = JSON.stringify(data, null, 2);
      const encrypted = encrypt(json, this.passphrase);
      if (encrypted) {
        fs.writeFileSync(codebotPath('vault.json'), encrypted, 'utf-8');
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
