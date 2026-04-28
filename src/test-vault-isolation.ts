/**
 * Test helper: create an isolated vault file path for tests that
 * construct a `VaultManager`.
 *
 * Honesty-pass finding (2026-04-28): pre-this-helper, every test that
 * called `new VaultManager()` wrote to the user's real
 * `~/.codebot/vault.json` because `VaultManager` defaulted to
 * `codebotPath('vault.json')` with no constructor override. Tests that
 * set `process.env.CODEBOT_VAULT_KEY = 'test-key-...'` then encrypted
 * the production vault with a passphrase production never sees,
 * silently leaving the user's real credentials unreadable
 * (`decrypt()` returns empty on failure — vault.ts:122-129).
 *
 * Same class of bug as the AuditLogger pollution closed by PR #33 via
 * `auditDir` constructor opt + `makeTestAuditDir()`.
 *
 * Tests should pass `vaultPath: makeTestVaultPath()` to the
 * VaultManager constructor opts. Cleanup is best-effort — tempdirs
 * under `os.tmpdir()` get cleared by the OS on a cadence; tests can
 * also `fs.rmSync` explicitly in their `after()` hook.
 *
 * NOT a production module — only test helpers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Create a fresh tempdir + vault path suitable for `new
 * VaultManager({ vaultPath })`. Returns the absolute file path
 * (`<tempdir>/vault.json`). The directory exists; the file does not
 * yet exist (the first `set()` call will create it).
 */
export function makeTestVaultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-vault-'));
  return path.join(dir, 'vault.json');
}
