import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  scoreConnector,
  formatScoreTable,
  type ContractScore,
} from './connector-contract';
import type { Connector } from './base';

import { GitHubConnector } from './github';
import { GmailConnector } from './gmail';
import { GoogleCalendarConnector } from './google-calendar';
import { GoogleDriveConnector } from './google-drive';
import { JiraConnector } from './jira';
import { LinearConnector } from './linear';
import { NotionConnector } from './notion';
import { OpenAIImagesConnector } from './openai-images';
import { ReplicateConnector } from './replicate';
import { SlackConnector } from './slack';
import { XTwitterConnector } from './x-twitter';

/**
 * PR 7 — contract compliance report (non-failing).
 *
 * Per §8 + the PR 7 review:
 *   - Existing 11 connectors are MEASURED but the report does NOT fail
 *     the build. They migrate to the contract one PR at a time
 *     (PR 8 = Gmail first).
 *   - New / migrated connector PRs MUST pass `assertContractClean`
 *     (which is hard-fail). That assertion lives in each connector's
 *     own test file once that connector is migrated.
 *
 * This test:
 *   - Confirms every registered connector type instantiates without
 *     throwing (smoke test).
 *   - Computes a per-connector compliance score and prints a table.
 *   - Records the aggregate so the number is visible — driving toward
 *     100% as connectors migrate.
 */

describe('Connector contract compliance — production connectors (non-failing report)', () => {
  const makeAll = (): Connector[] => [
    new GitHubConnector(),
    new GmailConnector(),
    new GoogleCalendarConnector(),
    new GoogleDriveConnector(),
    new JiraConnector(),
    new LinearConnector(),
    new NotionConnector(),
    new OpenAIImagesConnector(),
    new ReplicateConnector(),
    new SlackConnector(),
    new XTwitterConnector(),
  ];

  it('all 11 production connectors instantiate without throwing', () => {
    const all = makeAll();
    assert.strictEqual(all.length, 11);
    for (const c of all) {
      assert.ok(typeof c.name === 'string' && c.name.length > 0,
        `connector missing name: ${JSON.stringify(c)}`);
      assert.ok(Array.isArray(c.actions), `${c.name} has no actions array`);
    }
  });

  it('reports compliance score per connector (table output to stderr; does NOT fail)', () => {
    const all = makeAll();
    const scores: ContractScore[] = all.map(scoreConnector);
    const totalActions = scores.reduce((sum, s) => sum + s.totalActions, 0);
    const compliantActions = scores.reduce((sum, s) => sum + s.compliantActions, 0);
    const pct = totalActions === 0 ? 0 : Math.round((compliantActions / totalActions) * 100);

    // Print to stderr so test runner captures it but the assertion
    // below doesn't depend on it. Reviewers reading the CI log see the
    // current state without the build going red.
    process.stderr.write(formatScoreTable(scores) + '\n');
    process.stderr.write(`  TOTAL                ${compliantActions}/${totalActions} actions clean  (${pct}%)\n`);

    // The whole point of PR 7 is that we report rather than fail. Pin
    // the basic shape so the report keeps generating; do NOT pin the
    // numbers — those should drive upward in PR 8+ without breaking
    // this test.
    assert.ok(scores.length === 11);
    assert.ok(totalActions > 0);
    assert.ok(compliantActions >= 0);
    assert.ok(compliantActions <= totalActions);
  });
});
