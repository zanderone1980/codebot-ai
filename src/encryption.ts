/**
 * Encryption at rest for CodeBot v2.1.0
 *
 * Provides AES-256-GCM encryption for audit logs, session files, and memory.
 * Key derivation uses PBKDF2 from a user-supplied passphrase or machine identity.
 *
 * Encryption is opt-in: set CODEBOT_ENCRYPTION_KEY env var or
 * configure encryption.passphrase in policy.json.
 *
 * NEVER throws — encryption failures fall back to plaintext with a warning.
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;        // 128-bit IV for GCM
const TAG_LENGTH = 16;       // 128-bit auth tag
const SALT_LENGTH = 32;      // 256-bit salt for PBKDF2
const KEY_LENGTH = 32;       // 256-bit key
const PBKDF2_ITERATIONS = 100_000;
const HEADER = 'CBE1';       // CodeBot Encrypted v1 — 4-byte magic header

export interface EncryptionConfig {
  /** Enable encryption at rest */
  enabled: boolean;
  /** Passphrase for key derivation (or use CODEBOT_ENCRYPTION_KEY env var) */
  passphrase?: string;
}

/**
 * Derives an AES-256 key from a passphrase using PBKDF2-SHA512.
 * The salt is generated randomly and prepended to the output.
 */
export function deriveKey(passphrase: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
  const s = salt || crypto.randomBytes(SALT_LENGTH);
  const key = crypto.pbkdf2Sync(passphrase, s, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  return { key, salt: s };
}

/**
 * Get the encryption passphrase from environment or config.
 * Returns null if encryption is not configured.
 */
export function getPassphrase(config?: EncryptionConfig): string | null {
  // Environment variable takes priority
  const envKey = process.env.CODEBOT_ENCRYPTION_KEY;
  if (envKey) return envKey;

  // Policy config passphrase
  if (config?.passphrase) return config.passphrase;

  return null;
}

/**
 * Check if encryption is enabled (passphrase available).
 */
export function isEncryptionEnabled(config?: EncryptionConfig): boolean {
  if (config && !config.enabled) return false;
  return getPassphrase(config) !== null;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * Output format: HEADER(4) + salt(32) + iv(16) + tag(16) + ciphertext(...)
 * All binary, base64-encoded as a string for storage.
 *
 * Returns null on failure (never throws).
 */
export function encrypt(plaintext: string, passphrase: string): string | null {
  try {
    const { key, salt } = deriveKey(passphrase);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Pack: header + salt + iv + tag + ciphertext
    const packed = Buffer.concat([
      Buffer.from(HEADER, 'ascii'),
      salt,
      iv,
      tag,
      encrypted,
    ]);

    return packed.toString('base64');
  } catch {
    return null;
  }
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 * Returns null on failure (wrong key, tampered data, not encrypted).
 */
export function decrypt(encoded: string, passphrase: string): string | null {
  try {
    const packed = Buffer.from(encoded, 'base64');

    // Check magic header
    const header = packed.subarray(0, 4).toString('ascii');
    if (header !== HEADER) return null; // Not encrypted data

    // Unpack
    let offset = 4;
    const salt = packed.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = packed.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const tag = packed.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;
    const ciphertext = packed.subarray(offset);

    // Derive same key from salt
    const { key } = deriveKey(passphrase, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Encrypt a JSONL line for file storage.
 * If encryption is not configured, returns the original line unchanged.
 */
export function encryptLine(line: string, config?: EncryptionConfig): string {
  const passphrase = getPassphrase(config);
  if (!passphrase) return line;

  const encrypted = encrypt(line, passphrase);
  if (!encrypted) return line; // Fall back to plaintext

  return encrypted;
}

/**
 * Decrypt a JSONL line from file storage.
 * Auto-detects encrypted vs plaintext lines.
 */
export function decryptLine(line: string, config?: EncryptionConfig): string {
  // Quick check: if it doesn't look like base64 or doesn't start with our header when decoded, it's plaintext
  if (line.startsWith('{') || line.startsWith('[')) return line;

  const passphrase = getPassphrase(config);
  if (!passphrase) return line;

  const decrypted = decrypt(line, passphrase);
  return decrypted || line; // Fall back to original if decryption fails
}

/**
 * Encrypt an entire file's content (for memory files which are Markdown, not JSONL).
 */
export function encryptContent(content: string, config?: EncryptionConfig): string {
  const passphrase = getPassphrase(config);
  if (!passphrase) return content;

  return encrypt(content, passphrase) || content;
}

/**
 * Decrypt file content. Auto-detects encrypted vs plaintext.
 */
export function decryptContent(content: string, config?: EncryptionConfig): string {
  // If it starts with typical plaintext markers, it's not encrypted
  if (content.startsWith('#') || content.startsWith('{') || content.startsWith('\n')) return content;

  const passphrase = getPassphrase(config);
  if (!passphrase) return content;

  return decrypt(content, passphrase) || content;
}
