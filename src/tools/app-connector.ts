/**
 * App Connector Tool — Bridge between connector framework and tool system.
 *
 * Single tool named 'app' with dot-notation dispatch:
 *   app list                        → show all connectors + status
 *   app connect <app>               → save credential to vault
 *   app disconnect <app>            → remove from vault
 *   app github.create_issue { ... } → dispatch to connector action
 */

import { Tool, CapabilityLabel } from '../types';
import { ConnectorRegistry } from '../connectors/registry';
import { isConnectorReauthError } from '../connectors/base';
import { VaultManager } from '../vault';

export class AppConnectorTool implements Tool {
  name = 'app';
  description = 'Connect to external apps (GitHub, Slack, Jira, Linear). Use "list" to see available apps, "connect <app>" to set up, or "<app>.<action>" to execute (e.g., github.create_issue, slack.post_message, jira.search, linear.list_teams).';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['read-only', 'write-fs', 'net-fetch', 'account-access', 'send-on-behalf', 'delete-data'];
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "list", "connect", "disconnect", or "<app>.<action>" (e.g., "github.create_issue", "slack.post_message")',
      },
      app: { type: 'string', description: 'App name for connect/disconnect (e.g., "github", "slack")' },
      credential: { type: 'string', description: 'API key or token (for connect action)' },
      // Common connector action args — passed through dynamically
      owner: { type: 'string', description: 'Repository/resource owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Title for issues/PRs' },
      body: { type: 'string', description: 'Body/description content' },
      channel: { type: 'string', description: 'Slack channel' },
      message: { type: 'string', description: 'Message text' },
      query: { type: 'string', description: 'Search query' },
      project: { type: 'string', description: 'Project key (Jira)' },
      summary: { type: 'string', description: 'Summary (Jira)' },
      description: { type: 'string', description: 'Description text' },
      issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
      issue_id: { type: 'string', description: 'Issue ID (Linear)' },
      team_id: { type: 'string', description: 'Team ID (Linear)' },
      comment: { type: 'string', description: 'Comment text' },
      jql: { type: 'string', description: 'JQL search query (Jira)' },
      head: { type: 'string', description: 'Source branch (PR)' },
      base: { type: 'string', description: 'Target branch (PR)' },
      state: { type: 'string', description: 'State filter' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee: { type: 'string', description: 'Assignee username/ID' },
      assignees: { type: 'string', description: 'Comma-separated assignees' },
      assignee_id: { type: 'string', description: 'Assignee ID (Linear)' },
      state_id: { type: 'string', description: 'State ID (Linear)' },
      priority: { type: 'string', description: 'Priority level' },
      issuetype: { type: 'string', description: 'Issue type (Jira)' },
      per_page: { type: 'number', description: 'Results per page' },
      max_results: { type: 'number', description: 'Max results' },
      first: { type: 'number', description: 'Number of results (Linear)' },
      limit: { type: 'number', description: 'Result limit' },
      count: { type: 'number', description: 'Result count' },
      thread_ts: { type: 'string', description: 'Thread timestamp (Slack)' },
      status: { type: 'string', description: 'Status filter' },
    },
    required: ['action'],
  };

  private registry: ConnectorRegistry;

  constructor(vault: VaultManager, registry: ConnectorRegistry) {
    this.registry = registry;
  }

  /**
   * PR 11 — resolve real per-action labels.
   *
   * The static `capabilities` field above is the union over every
   * connector action ever registered. That over-gates pure reads:
   * `github.list_prs` (read-only + account-access + net-fetch) was
   * being scored as if it were `send-on-behalf` because the union
   * carries the worst case.
   *
   * Resolution rules, in order:
   *   1. Meta actions (`list`, `connect`, `disconnect`) — local to this
   *      tool, no remote call. The most permissive narrowing makes
   *      sense: drop everything except the labels they actually need.
   *      `list` is purely local read, so it gets `[]` (auto). `connect`
   *      and `disconnect` write to the local vault, so `write-fs`.
   *   2. Connector dispatch (`<app>.<action>`) — look up the action on
   *      the registry; if found and the action declares its own
   *      `capabilities`, return that exact list. If the action exists
   *      but declares no labels, fall back to the connector's union
   *      (still narrower than the tool union). If the action lookup
   *      fails (unknown app or unknown action), return `undefined` so
   *      the agent falls back to the tool union — the conservative
   *      default — and the action will fail at execute() with a
   *      precise error anyway.
   *
   * Pure: no I/O, no auth checks, no side effects. Reads only registry
   * metadata that's already in memory.
   */
  effectiveCapabilities(args: Record<string, unknown>): CapabilityLabel[] | undefined {
    const action = (args.action as string) || '';
    if (!action) return undefined;

    if (action === 'list') return [];
    if (action === 'connect' || action === 'disconnect') return ['write-fs'];

    if (!action.includes('.')) return undefined;

    const dotIdx = action.indexOf('.');
    const appName = action.substring(0, dotIdx);
    const actionName = action.substring(dotIdx + 1);

    const connector = this.registry.get(appName);
    if (!connector) return undefined;

    const connectorAction = connector.actions.find(a => a.name === actionName);
    if (!connectorAction) return undefined;

    if (connectorAction.capabilities && connectorAction.capabilities.length > 0) {
      return [...connectorAction.capabilities];
    }
    // Action exists but declares no labels — derive a connector-wide
    // union from sibling actions. Still narrower than the tool union.
    const unionSet = new Set<CapabilityLabel>();
    for (const a of connector.actions) {
      for (const l of (a.capabilities || [])) unionSet.add(l);
    }
    return unionSet.size > 0 ? [...unionSet] : undefined;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    if (!action) return 'Error: action is required';

    // Meta actions
    if (action === 'list') return this.listConnectors();
    if (action === 'connect') return this.connect(args);
    if (action === 'disconnect') return this.disconnect(args);

    // Connector dispatch: "<app>.<action>"
    if (action.includes('.')) {
      const dotIdx = action.indexOf('.');
      const appName = action.substring(0, dotIdx);
      const actionName = action.substring(dotIdx + 1);
      return this.executeAction(appName, actionName, args);
    }

    return `Error: unknown action "${action}". Use: list, connect, disconnect, or <app>.<action> (e.g., github.create_issue)`;
  }

  private listConnectors(): string {
    const all = this.registry.all();
    if (!all.length) return 'No connectors registered.';

    const lines = all.map(c => {
      const connected = this.registry.isConnected(c.name);
      const status = connected ? '\u2705 connected' : '\u26aa not connected';
      const envHint = c.envKey ? ` (env: ${c.envKey})` : '';
      const actions = c.actions.map(a => a.name).join(', ');
      return `  ${c.displayName} [${c.name}] — ${status}${envHint}\n    Actions: ${actions}`;
    });
    return `App Connectors:\n${lines.join('\n')}`;
  }

  private async connect(args: Record<string, unknown>): Promise<string> {
    const appName = args.app as string;
    if (!appName) return 'Error: app name is required (e.g., app connect github)';

    const connector = this.registry.get(appName);
    if (!connector) return `Error: unknown app "${appName}". Available: ${this.registry.all().map(c => c.name).join(', ')}`;

    let credential = args.credential as string;

    // Try env var if no credential provided. Bind the env value to a
    // local so TS narrows it away from `string | undefined` and we
    // don't need `process.env[key]!`.
    if (!credential && connector.envKey) {
      const envVal = process.env[connector.envKey];
      if (envVal) credential = envVal;
    }

    // For multi-key auth (Jira), bundle env vars. Same trick — read
    // each env value into a local and guard it; skip the bundle if any
    // key is missing instead of asserting non-null.
    if (!credential && connector.requiredEnvKeys) {
      const bundle: Record<string, string> = {};
      let allPresent = true;
      for (const k of connector.requiredEnvKeys) {
        const v = process.env[k];
        if (!v) { allPresent = false; break; }
        bundle[k] = v;
      }
      if (allPresent) credential = JSON.stringify(bundle);
    }

    if (!credential) {
      const hint = connector.envKey
        ? `Provide a credential or set the ${connector.envKey} environment variable.`
        : `Provide a credential via the "credential" parameter.`;
      return `Error: no credential provided for ${connector.displayName}. ${hint}`;
    }

    // Validate
    try {
      const valid = await connector.validate(credential);
      if (!valid) return `Error: invalid credential for ${connector.displayName}. Please check your API key/token.`;
    } catch (err: unknown) {
      return `Error: could not validate ${connector.displayName} credential: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Save to vault
    const vault = this.registry.getVault();
    vault.set(appName, {
      type: 'api_key',
      value: credential,
      metadata: {
        provider: connector.displayName,
        created: new Date().toISOString(),
      },
    });

    return `${connector.displayName} connected successfully. Available actions: ${connector.actions.map(a => a.name).join(', ')}`;
  }

  private disconnect(args: Record<string, unknown>): string {
    const appName = args.app as string;
    if (!appName) return 'Error: app name is required';

    const connector = this.registry.get(appName);
    if (!connector) return `Error: unknown app "${appName}"`;

    const vault = this.registry.getVault();
    const removed = vault.delete(appName);
    return removed
      ? `${connector.displayName} disconnected. Credential removed from vault.`
      : `${connector.displayName} was not in the vault (may still work via env var).`;
  }

  private async executeAction(appName: string, actionName: string, args: Record<string, unknown>): Promise<string> {
    const connector = this.registry.get(appName);
    if (!connector) return `Error: unknown app "${appName}". Available: ${this.registry.all().map(c => c.name).join(', ')}`;

    const credential = this.registry.getCredential(appName);
    if (!credential) {
      const envHint = connector.envKey ? ` Set ${connector.envKey} or use: app connect ${appName}` : '';
      return `Error: ${connector.displayName} is not connected.${envHint}`;
    }

    const action = connector.actions.find(a => a.name === actionName);
    if (!action) {
      const available = connector.actions.map(a => a.name).join(', ');
      return `Error: unknown action "${actionName}" for ${connector.displayName}. Available: ${available}`;
    }

    try {
      return await action.execute(args, credential);
    } catch (err: unknown) {
      // PR 7 — structured reauth signal. Connectors throw
      // ConnectorReauthError when the credential is expired/revoked/
      // insufficient. Catch it here and return a recognizable string;
      // tests assert the error is catchable by `kind === 'reauth-required'`
      // (via `isConnectorReauthError`) BEFORE this string formatting,
      // so the structure is preserved as the contract.
      if (isConnectorReauthError(err)) {
        return `Error: re-authentication required for ${connector.displayName}. Run: app connect ${appName}`;
      }
      return `Error: ${connector.displayName}.${actionName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
