/**
 * Test helper: create an isolated audit directory for tests that
 * construct an `Agent`.
 *
 * Honesty-pass finding (2026-04-25): pre-this-helper, every test that
 * called `new Agent({...})` wrote audit entries into the user's real
 * `~/.codebot/audit/` because `AuditLogger` defaults to that location
 * when constructed without an arg. Test sessions ended up mixed with
 * production sessions in audit history.
 *
 * Tests should pass `auditDir: makeTestAuditDir()` to the Agent
 * constructor opts. Cleanup is best-effort — tempdirs under
 * `os.tmpdir()` get cleared by the OS on a cadence; tests can also
 * `fs.rmSync` explicitly in their `after()` hook.
 *
 * NOT a production module — only test helpers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Create a fresh tempdir suitable as `auditDir` on Agent construction.
 * Returns the absolute path. Caller is responsible for cleanup if
 * deterministic cleanup is wanted (e.g. via a node:test `after()` hook).
 */
export function makeTestAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-audit-'));
}
