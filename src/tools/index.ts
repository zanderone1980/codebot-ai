import { Tool, ToolSchema } from '../types';
import { ReadFileTool } from './read';
import { WriteFileTool } from './write';
import { EditFileTool } from './edit';
import { ExecuteTool } from './execute';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
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

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(projectRoot?: string, policyEnforcer?: PolicyEnforcer) {
    // Core file tools — policy-enforced tools receive the enforcer
    this.register(new ReadFileTool(projectRoot));
    this.register(new WriteFileTool(policyEnforcer, projectRoot));
    this.register(new EditFileTool(policyEnforcer, projectRoot));
    this.register(new BatchEditTool(policyEnforcer, projectRoot));
    this.register(new ExecuteTool(projectRoot));
    this.register(new GlobTool(projectRoot));
    this.register(new GrepTool(projectRoot));
    this.register(new ThinkTool());
    this.register(new MemoryTool(projectRoot));
    // Web & browser
    this.register(new WebFetchTool());
    this.register(new WebSearchTool());
    this.register(new BrowserTool());
    this.register(new RoutineTool());
    // v1.4.0 — intelligence & dev tools
    this.register(new GitTool(policyEnforcer));
    this.register(new CodeAnalysisTool());
    this.register(new MultiSearchTool());
    this.register(new TaskPlannerTool());
    this.register(new DiffViewerTool());
    this.register(new DockerTool());
    this.register(new DatabaseTool());
    this.register(new TestRunnerTool());
    this.register(new HttpClientTool());
    this.register(new ImageInfoTool());
    this.register(new SshRemoteTool());
    this.register(new NotificationTool());
    this.register(new PdfExtractTool());
    this.register(new PackageManagerTool());
    this.register(new CodeReviewTool());
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
      this.register(new AppConnectorTool(vault, connectorRegistry));
    }

    // Non-connector tools — always register regardless of connector status
    this.register(new GraphicsTool());
    this.register(new DeepResearchTool());
    this.register(new SkillForgeTool());
    this.register(new DecomposeGoalTool());
    this.register(new PluginForgeTool());
    this.register(new DelegateTool());
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
