import * as vscode from 'vscode';
import { AgentBridge } from './agent-bridge';
import { getWebviewContent } from './webview';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from './types';
import type { AgentEvent } from 'codebot-ai';

/**
 * Provides the CodeBot chat sidebar webview.
 * Manages agent lifecycle and message passing between the webview and the AgentBridge.
 */
export class ChatSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebotChat';

  private view?: vscode.WebviewView;
  private bridge?: AgentBridge;
  private readonly extensionUri: vscode.Uri;
  private readonly outputChannel: vscode.OutputChannel;

  /**
   * Event emitter for agent events, allowing other components
   * (e.g., StatusBarManager) to subscribe.
   */
  private readonly _onAgentEvent = new vscode.EventEmitter<AgentEvent>();
  public readonly onAgentEvent = this._onAgentEvent.event;

  constructor(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
    this.extensionUri = extensionUri;
    this.outputChannel = outputChannel;
  }

  /**
   * Called by VS Code when the webview view is first made visible.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = getWebviewContent(
      webviewView.webview,
      this.extensionUri
    );

    // Listen for messages from the webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.handleWebviewMessage(message);
      }
    );

    // Clean up bridge when the view is disposed
    webviewView.onDidDispose(() => {
      this.bridge?.reset();
      this.bridge = undefined;
    });
  }

  /**
   * Handles incoming messages from the webview frontend.
   */
  private handleWebviewMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case 'sendMessage':
        this.handleSendMessage(message.text);
        break;

      case 'cancelSession':
        this.handleCancelSession();
        break;

      case 'clearHistory':
        this.handleClearHistory();
        break;
    }
  }

  /**
   * Creates or reuses an AgentBridge and runs the user's message.
   */
  private async handleSendMessage(text: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('codebot');
    const provider = config.get<string>('provider', 'openai');
    const model = config.get<string>('model', '');
    const apiKey = config.get<string>('apiKey', '');
    const autoApprove = config.get<boolean>('autoApprove', false);
    const maxIterations = config.get<number>('maxIterations', 25);

    const workspaceRoot = this.getWorkspaceRoot();

    // Create bridge if it doesn't exist or config has changed
    if (!this.bridge) {
      this.bridge = new AgentBridge({
        workspaceRoot,
        provider,
        model,
        apiKey,
        autoApprove,
        maxIterations,
        onEvent: (event: AgentEvent) => {
          this.postToWebview({ type: 'agentEvent', event });
          this._onAgentEvent.fire(event);
        },
        onPermissionRequest: async (
          tool: string,
          args: Record<string, unknown>
        ): Promise<boolean> => {
          const argsPreview = JSON.stringify(args, null, 2);
          const truncated =
            argsPreview.length > 300
              ? argsPreview.substring(0, 300) + '...'
              : argsPreview;

          const result = await vscode.window.showWarningMessage(
            `CodeBot wants to use tool: ${tool}\n\n${truncated}`,
            { modal: true },
            'Allow',
            'Deny'
          );
          return result === 'Allow';
        },
      });

      try {
        this.bridge.createAgent();
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Failed to create agent';
        this.postToWebview({ type: 'error', message: errorMsg });
        this.outputChannel.appendLine(`[ERROR] ${errorMsg}`);
        this.bridge = undefined;
        return;
      }
    }

    // Notify webview that the session has started
    this.postToWebview({
      type: 'sessionStarted',
      provider,
      model: model || '(default)',
    });

    try {
      await this.bridge.run(text);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Agent run failed';
      this.postToWebview({ type: 'error', message: errorMsg });
      this.outputChannel.appendLine(`[ERROR] ${errorMsg}`);
    } finally {
      this.postToWebview({ type: 'sessionEnded' });
    }
  }

  /**
   * Stops the currently running agent.
   */
  private handleCancelSession(): void {
    if (this.bridge) {
      this.bridge.stop();
      this.outputChannel.appendLine('[INFO] Session cancelled by user');
    }
  }

  /**
   * Resets the agent and clears history.
   */
  private handleClearHistory(): void {
    if (this.bridge) {
      this.bridge.reset();
      this.bridge = undefined;
      this.outputChannel.appendLine('[INFO] Session cleared');
    }
  }

  /**
   * Posts a typed message to the webview.
   */
  private postToWebview(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Gets the first workspace folder root, or the home directory.
   */
  private getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return process.env.HOME || process.env.USERPROFILE || '/';
  }

  /**
   * Programmatically start a new session (used by the startSession command).
   */
  public startNewSession(): void {
    this.handleClearHistory();
    vscode.commands.executeCommand('codebotChat.focus');
  }

  /**
   * Shows usage statistics from the current agent session.
   */
  public async showUsage(): Promise<void> {
    const agent = this.bridge?.getAgent();
    if (!agent) {
      vscode.window.showInformationMessage(
        'No active CodeBot session. Start a session first.'
      );
      return;
    }

    const tracker = agent.getTokenTracker();
    const metrics = agent.getMetrics();

    const items: string[] = [];

    if (tracker) {
      const stats = tracker as Record<string, unknown>;
      items.push(`Tokens: ${JSON.stringify(stats, null, 2)}`);
    }

    if (metrics) {
      const data = metrics as Record<string, unknown>;
      items.push(`Metrics: ${JSON.stringify(data, null, 2)}`);
    }

    if (items.length === 0) {
      vscode.window.showInformationMessage('No usage data available yet.');
      return;
    }

    // Show in an output channel for readability
    this.outputChannel.clear();
    this.outputChannel.appendLine('=== CodeBot AI Usage Statistics ===\n');
    for (const item of items) {
      this.outputChannel.appendLine(item);
    }
    this.outputChannel.show();
  }
}
