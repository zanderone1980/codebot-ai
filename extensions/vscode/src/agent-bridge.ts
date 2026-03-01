import {
  Agent,
  OpenAIProvider,
  AnthropicProvider,
  detectProvider,
  PROVIDER_DEFAULTS,
} from 'codebot-ai';
import type { AgentEvent, LLMProvider } from 'codebot-ai';

export interface AgentBridgeOptions {
  workspaceRoot: string;
  provider: string;
  model: string;
  apiKey: string;
  autoApprove: boolean;
  maxIterations: number;
  onEvent: (event: AgentEvent) => void;
  onPermissionRequest: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
}

export class AgentBridge {
  private agent: Agent | null = null;
  private aborted = false;
  private running = false;
  private readonly options: AgentBridgeOptions;

  constructor(options: AgentBridgeOptions) {
    this.options = options;
  }

  /**
   * Creates the LLM provider instance based on configuration.
   */
  private createProvider(): LLMProvider {
    const { provider, apiKey } = this.options;

    if (apiKey) {
      switch (provider) {
        case 'anthropic':
          return new AnthropicProvider({ apiKey });
        case 'openai':
        default:
          return new OpenAIProvider({ apiKey });
      }
    }

    // Fall back to auto-detection from environment variables
    const detected = detectProvider();
    if (detected) {
      return detected;
    }

    // Last resort: create provider without explicit key (will read from env)
    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider({});
      case 'openai':
      default:
        return new OpenAIProvider({});
    }
  }

  /**
   * Resolves the model name, falling back to provider defaults.
   */
  private resolveModel(): string {
    if (this.options.model) {
      return this.options.model;
    }
    const providerName = this.options.provider || 'openai';
    const defaults = PROVIDER_DEFAULTS[providerName];
    return defaults?.model ?? 'gpt-4o';
  }

  /**
   * Creates a new Agent instance. Call this before the first run()
   * or to reset the agent for a new session.
   */
  public createAgent(): Agent {
    const llmProvider = this.createProvider();
    const model = this.resolveModel();

    this.agent = new Agent({
      provider: llmProvider,
      model,
      providerName: this.options.provider,
      maxIterations: this.options.maxIterations,
      autoApprove: this.options.autoApprove,
      projectRoot: this.options.workspaceRoot,
      askPermission: this.options.onPermissionRequest,
      onMessage: () => {
        // Messages are handled via the event stream
      },
    });

    this.aborted = false;
    return this.agent;
  }

  /**
   * Runs the agent with the given user message, streaming events
   * through the onEvent callback.
   */
  public async run(message: string): Promise<void> {
    if (!this.agent) {
      this.createAgent();
    }

    if (this.running) {
      throw new Error('Agent is already running. Stop the current run first.');
    }

    this.running = true;
    this.aborted = false;

    try {
      const generator = this.agent!.run(message);

      for await (const event of generator) {
        if (this.aborted) {
          break;
        }
        this.options.onEvent(event);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.options.onEvent({
        type: 'error',
        error: errorMessage,
      } as AgentEvent);
    } finally {
      this.running = false;
    }
  }

  /**
   * Signals the current run to stop at the next iteration boundary.
   */
  public stop(): void {
    this.aborted = true;
  }

  /**
   * Returns the current Agent instance, or null if not yet created.
   */
  public getAgent(): Agent | null {
    return this.agent;
  }

  /**
   * Returns whether the agent is currently running.
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Destroys the current agent, freeing resources.
   */
  public reset(): void {
    this.stop();
    this.agent = null;
  }
}
