import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { encrypt, decrypt, encryptLine, decryptLine, encryptContent, decryptContent, isEncryptionEnabled, deriveKey, getPassphrase } from './encryption';
import type { EncryptionConfig } from './encryption';

describe('Encryption — deriveKey', () => {
  it('derives a 32-byte key from a passphrase', () => {
    const { key, salt } = deriveKey('test-passphrase');
    assert.strictEqual(key.length, 32);
    assert.strictEqual(salt.length, 32);
  });

  it('produces deterministic key with same salt', () => {
    const { key: key1, salt } = deriveKey('my-secret');
    const { key: key2 } = deriveKey('my-secret', salt);
    assert.ok(key1.equals(key2));
  });

  it('produces different keys with different passphrases', () => {
    const { key: key1, salt } = deriveKey('pass-1');
    const { key: key2 } = deriveKey('pass-2', salt);
    assert.ok(!key1.equals(key2));
  });

  it('generates random salt when not provided', () => {
    const { salt: salt1 } = deriveKey('pass');
    const { salt: salt2 } = deriveKey('pass');
    assert.ok(!salt1.equals(salt2));
  });
});

describe('Encryption — encrypt/decrypt', () => {
  const passphrase = 'test-encryption-key-2024';

  it('encrypts and decrypts a string', () => {
    const plaintext = 'Hello, world! This is sensitive data.';
    const encrypted = encrypt(plaintext, passphrase);
    assert.ok(encrypted);
    assert.notStrictEqual(encrypted, plaintext);

    const decrypted = decrypt(encrypted, passphrase);
    assert.strictEqual(decrypted, plaintext);
  });

  it('encrypts to base64 format', () => {
    const encrypted = encrypt('test', passphrase);
    assert.ok(encrypted);
    // Valid base64 regex
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(encrypted));
  });

  it('produces different ciphertext each time (random IV)', () => {
    const enc1 = encrypt('same input', passphrase);
    const enc2 = encrypt('same input', passphrase);
    assert.ok(enc1);
    assert.ok(enc2);
    assert.notStrictEqual(enc1, enc2); // Different IV = different output
  });

  it('fails to decrypt with wrong passphrase', () => {
    const encrypted = encrypt('secret', passphrase);
    assert.ok(encrypted);
    const result = decrypt(encrypted, 'wrong-passphrase');
    assert.strictEqual(result, null);
  });

  it('returns null for non-encrypted data', () => {
    const result = decrypt('not-base64-encrypted-data', passphrase);
    assert.strictEqual(result, null);
  });

  it('returns null for tampered ciphertext', () => {
    const encrypted = encrypt('test', passphrase);
    assert.ok(encrypted);
    // Tamper with the ciphertext by changing a character
    const tampered = encrypted.slice(0, -5) + 'XXXXX';
    const result = decrypt(tampered, passphrase);
    assert.strictEqual(result, null);
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', passphrase);
    assert.ok(encrypted);
    const decrypted = decrypt(encrypted, passphrase);
    assert.strictEqual(decrypted, '');
  });

  it('handles unicode content', () => {
    const plaintext = '日本語テスト 🔐 encryption';
    const encrypted = encrypt(plaintext, passphrase);
    assert.ok(encrypted);
    const decrypted = decrypt(encrypted, passphrase);
    assert.strictEqual(decrypted, plaintext);
  });

  it('handles large content', () => {
    const plaintext = 'x'.repeat(100_000);
    const encrypted = encrypt(plaintext, passphrase);
    assert.ok(encrypted);
    const decrypted = decrypt(encrypted, passphrase);
    assert.strictEqual(decrypted, plaintext);
  });
});

describe('Encryption — getPassphrase', () => {
  const originalEnv = process.env.CODEBOT_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CODEBOT_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.CODEBOT_ENCRYPTION_KEY;
    }
  });

  it('returns null when no config and no env var', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    assert.strictEqual(getPassphrase(), null);
  });

  it('returns env var when set', () => {
    process.env.CODEBOT_ENCRYPTION_KEY = 'env-key-123';
    assert.strictEqual(getPassphrase(), 'env-key-123');
  });

  it('returns config passphrase', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    const config: EncryptionConfig = { enabled: true, passphrase: 'config-pass' };
    assert.strictEqual(getPassphrase(config), 'config-pass');
  });

  it('env var takes priority over config', () => {
    process.env.CODEBOT_ENCRYPTION_KEY = 'env-wins';
    const config: EncryptionConfig = { enabled: true, passphrase: 'config-loses' };
    assert.strictEqual(getPassphrase(config), 'env-wins');
  });
});

describe('Encryption — isEncryptionEnabled', () => {
  const originalEnv = process.env.CODEBOT_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CODEBOT_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.CODEBOT_ENCRYPTION_KEY;
    }
  });

  it('returns false when no passphrase available', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    assert.strictEqual(isEncryptionEnabled(), false);
  });

  it('returns true when env var is set', () => {
    process.env.CODEBOT_ENCRYPTION_KEY = 'my-key';
    assert.strictEqual(isEncryptionEnabled(), true);
  });

  it('returns false when config.enabled is false', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    const config: EncryptionConfig = { enabled: false, passphrase: 'has-pass' };
    assert.strictEqual(isEncryptionEnabled(config), false);
  });
});

describe('Encryption — encryptLine/decryptLine', () => {
  const originalEnv = process.env.CODEBOT_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CODEBOT_ENCRYPTION_KEY = 'line-encryption-key';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CODEBOT_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.CODEBOT_ENCRYPTION_KEY;
    }
  });

  it('encrypts and decrypts a JSONL line', () => {
    const line = '{"tool":"read_file","timestamp":"2024-01-01"}';
    const encrypted = encryptLine(line);
    assert.notStrictEqual(encrypted, line);

    const decrypted = decryptLine(encrypted);
    assert.strictEqual(decrypted, line);
  });

  it('passes through plaintext when no key set', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    const line = '{"hello":"world"}';
    assert.strictEqual(encryptLine(line), line);
  });

  it('auto-detects plaintext JSON lines', () => {
    const line = '{"already":"plaintext"}';
    const result = decryptLine(line);
    assert.strictEqual(result, line);
  });
});

describe('Encryption — encryptContent/decryptContent', () => {
  const originalEnv = process.env.CODEBOT_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CODEBOT_ENCRYPTION_KEY = 'content-encryption-key';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CODEBOT_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.CODEBOT_ENCRYPTION_KEY;
    }
  });

  it('encrypts and decrypts markdown content', () => {
    const content = '# Memory\n\n- Project uses TypeScript\n- Zero dependencies';
    const encrypted = encryptContent(content);
    assert.notStrictEqual(encrypted, content);

    const decrypted = decryptContent(encrypted);
    assert.strictEqual(decrypted, content);
  });

  it('passes through when no key set', () => {
    delete process.env.CODEBOT_ENCRYPTION_KEY;
    const content = '# No encryption';
    assert.strictEqual(encryptContent(content), content);
  });
});
