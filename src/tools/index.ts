import { Tool, ToolSchema } from '../types';
import { ReadFileTool } from './read';
import { WriteFileTool } from './write';
import { EditFileTool } from './edit';
import { ExecuteTool } from './execute';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { FindSymbolTool } from './find-symbol';
import { ThinkTool } from './think';
import { DelegateTool } from './delegate';
import { MemoryTool } from './memory';
import { WebFetchTool } from './web-fetch';
import { WebSearchTool } from './web-search';
import { BrowserTool } from './browser';
import { BatchEditTool } from './batch-edit';
import { RoutineTool } from './routine';
// v1.4.0 — 15 new tools
import { GitTool } from './git';
import { CodeAnalysisTool } from './code-analysis';
import { MultiSearchTool } from './multi-search';
import { TaskPlannerTool } from './task-planner';
import { DiffViewerTool } from './diff-viewer';
import { DockerTool } from './docker';
import { DatabaseTool } from './database';
import { TestRunnerTool } from './test-runner';
import { HttpClientTool } from './http-client';
import { ImageInfoTool } from './image-info';
import { SshRemoteTool } from './ssh-remote';
import { NotificationTool } from './notification';
import { PdfExtractTool } from './pdf-extract';
import { PackageManagerTool } from './package-manager';
import { CodeReviewTool } from './code-review';
import { PolicyEnforcer } from '../policy';
import { AppConnectorTool } from './app-connector';
import { GraphicsTool } from './graphics';
import { VaultManager } from '../vault';
import { ConnectorRegistry } from '../connectors/registry';
import { GitHubConnector } from '../connectors/github';
import { SlackConnector } from '../connectors/slack';
import { JiraConnector } from '../connectors/jira';
import { LinearConnector } from '../connectors/linear';
import { OpenAIImagesConnector } from '../connectors/openai-images';
import { ReplicateConnector } from '../connectors/replicate';
import { GmailConnector } from '../connectors/gmail';
import { GoogleCalendarConnector } from '../connectors/google-calendar';
import { NotionConnector } from '../connectors/notion';
import { GoogleDriveConnector } from '../connectors/google-drive';
import { DeepResearchTool } from './research';
import { SkillForgeTool } from './skill-forge';
import { DecomposeGoalTool } from './decompose-goal';
import { PluginForgeTool } from './plugin-forge';
import { log } from '../logger';

export { EditFileTool } from './edit';

/** Tool tier categorization: core (essential), standard (useful dev), labs (experimental) */
export const TOOL_TIERS: Record<string, 'core' | 'standard' | 'labs'> = {
  read_file: 'core',
  write_file: 'core',
  edit_file: 'core',
  batch_edit: 'core',
  execute: 'core',
  glob: 'core',
  grep: 'core',
  find_symbol: 'core',
  git: 'core',
  test_runner: 'core',
  think: 'core',
  memory: 'core',
  code_analysis: 'standard',
  multi_search: 'standard',
  diff_viewer: 'standard',
  code_review: 'standard',
  package_manager: 'standard',
  task_planner: 'standard',
  web_search: 'standard',
  web_fetch: 'standard',
  http_client: 'standard',
  database: 'standard',
  pdf_extract: 'standard',
  image_info: 'standard',
  browser: 'labs',
  docker: 'labs',
  ssh_remote: 'labs',
  routine: 'labs',
  notification: 'labs',
  graphics: 'labs',
  deep_research: 'labs',
  skill_forge: 'labs',
  plugin_forge: 'labs',
  decompose_goal: 'labs',
  delegate: 'labs',
  app: 'labs',
};

/**
 * Tools available in Vault Mode (read-only notes agent).
 * Everything NOT in here is dropped from the registry when --vault is set.
 * See docs/rfcs/… for the full Vault Mode spec.
 */
const VAULT_CORE_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'find_symbol', 'think', 'memory',
  'pdf_extract', 'image_info', 'multi_search',
]);
/** Adds when --vault-writable is passed. */
const VAULT_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'batch_edit']);
/** Adds when --vault-allow-network is passed. */
const VAULT_NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'http_client']);

export interface ToolRegistryOpts {
  vaultMode?: {
    vaultPath: string;
    writable: boolean;
    networkAllowed: boolean;
  };
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private readonly vaultMode?: ToolRegistryOpts['vaultMode'];

  constructor(projectRoot?: string, policyEnforcer?: PolicyEnforcer, opts?: ToolRegistryOpts) {
    this.vaultMode = opts?.vaultMode;

    /**
     * Gate every register() call when in vault mode. Drops tools that
     * don't fit the vault context (shell, docker, git-write, connectors,
     * etc.) and optionally the write/network sets unless their opt-in
     * flags were set.
     */
    const allow = (toolName: string): boolean => {
      if (!this.vaultMode) return true;
      if (VAULT_CORE_TOOLS.has(toolName)) return true;
      if (this.vaultMode.writable && VAULT_WRITE_TOOLS.has(toolName)) return true;
      if (this.vaultMode.networkAllowed && VAULT_NETWORK_TOOLS.has(toolName)) return true;
      return false;
    };
    const regIf = (tool: Tool): void => {
      if (allow(tool.name)) this.register(tool);
    };

    // Core file tools — policy-enforced tools receive the enforcer
    regIf(new ReadFileTool(projectRoot));
    regIf(new WriteFileTool(policyEnforcer, projectRoot));
    regIf(new EditFileTool(policyEnforcer, projectRoot));
    regIf(new BatchEditTool(policyEnforcer, projectRoot));
    regIf(new ExecuteTool(projectRoot));
    regIf(new GlobTool(projectRoot));
    regIf(new GrepTool(projectRoot));
    // RFC 001 Part A — symbol-based localization, complements GrepTool
    regIf(new FindSymbolTool(projectRoot));
    regIf(new ThinkTool());
    regIf(new MemoryTool(projectRoot));
    // Web & browser
    regIf(new WebFetchTool());
    regIf(new WebSearchTool());
    regIf(new BrowserTool());
    regIf(new RoutineTool());
    // v1.4.0 — intelligence & dev tools
    regIf(new GitTool(policyEnforcer));
    regIf(new CodeAnalysisTool());
    regIf(new MultiSearchTool());
    regIf(new TaskPlannerTool());
    regIf(new DiffViewerTool());
    regIf(new DockerTool());
    regIf(new DatabaseTool());
    regIf(new TestRunnerTool());
    regIf(new HttpClientTool());
    regIf(new ImageInfoTool());
    regIf(new SshRemoteTool());
    regIf(new NotificationTool());
    regIf(new PdfExtractTool());
    regIf(new PackageManagerTool());
    regIf(new CodeReviewTool());
    // v2.5.0 — App Connectors
    let vault: VaultManager | undefined;
    let connectorRegistry: ConnectorRegistry | undefined;
    try {
      vault = new VaultManager();
      connectorRegistry = new ConnectorRegistry(vault);
    } catch (err) {
      log.warn('[ToolRegistry] Vault/ConnectorRegistry init failed:', err);
    }

    if (vault && connectorRegistry) {
      const connectors: Array<{ name: string; create: () => any }> = [
        { name: 'GitHub', create: () => new GitHubConnector() },
        { name: 'Slack', create: () => new SlackConnector() },
        { name: 'Jira', create: () => new JiraConnector() },
        { name: 'Linear', create: () => new LinearConnector() },
        { name: 'OpenAIImages', create: () => new OpenAIImagesConnector() },
        { name: 'Replicate', create: () => new ReplicateConnector() },
        { name: 'Gmail', create: () => new GmailConnector() },
        { name: 'GoogleCalendar', create: () => new GoogleCalendarConnector() },
        { name: 'Notion', create: () => new NotionConnector() },
        { name: 'GoogleDrive', create: () => new GoogleDriveConnector() },
      ];
      for (const c of connectors) {
        try {
          connectorRegistry.register(c.create());
        } catch (err) {
          log.warn(`[ToolRegistry] ${c.name} connector failed to register:`, err);
        }
      }
      regIf(new AppConnectorTool(vault, connectorRegistry));
    }

    // Non-connector tools — always register regardless of connector status
    regIf(new GraphicsTool());
    regIf(new DeepResearchTool());
    regIf(new SkillForgeTool());
    regIf(new DecomposeGoalTool());
    regIf(new PluginForgeTool());
    regIf(new DelegateTool());
  }

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Get tools by tier */
  getToolsByTier(tier: 'core' | 'standard' | 'labs'): Tool[] {
    return this.all().filter((t) => (TOOL_TIERS[t.name] || 'unknown') === tier);
  }

  /** Get tier for a tool */
  getToolTier(name: string): string {
    return TOOL_TIERS[name] || 'unknown';
  }

  /** Get core tools only */
  getCoreTools(): Tool[] {
    return this.getToolsByTier('core');
  }

  /** Get tool counts by tier */
  getToolCount(): { core: number; standard: number; labs: number; total: number } {
    const all = this.all();
    return {
      core: all.filter((t) => TOOL_TIERS[t.name] === 'core').length,
      standard: all.filter((t) => TOOL_TIERS[t.name] === 'standard').length,
      labs: all.filter((t) => TOOL_TIERS[t.name] === 'labs').length,
      total: all.length,
    };
  }
}
