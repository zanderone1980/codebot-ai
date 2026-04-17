/**
 * App Connector Tool — Bridge between connector framework and tool system.
 *
 * Single tool named 'app' with dot-notation dispatch:
 *   app list                        → show all connectors + status
 *   app connect <app>               → save credential to vault
 *   app disconnect <app>            → remove from vault
 *   app github.create_issue { ... } → dispatch to connector action
 */

import { Tool } from '../types';
import { ConnectorRegistry } from '../connectors/registry';
import { VaultManager } from '../vault';

export class AppConnectorTool implements Tool {
  name = 'app';
  description = 'Connect to external apps (GitHub, Slack, Jira, Linear). Use "list" to see available apps, "connect <app>" to set up, or "<app>.<action>" to execute (e.g., github.create_issue, slack.post_message, jira.search, linear.list_teams).';
  permission: Tool['permission'] = 'prompt';
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
      return `Error: ${connector.displayName}.${actionName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
