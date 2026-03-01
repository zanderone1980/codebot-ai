import * as vscode from 'vscode';
import { ChatSidebarProvider } from './sidebar';
import { StatusBarManager } from './status-bar';
import {
  DiffPreviewProvider,
  CODEBOT_PROPOSED_SCHEME,
} from './diff-preview';

/**
 * Called when the extension is activated.
 * Registers all providers, commands, and UI components.
 */
export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('CodeBot AI');
  outputChannel.appendLine('CodeBot AI extension activating...');

  // ── Diff Preview Provider ──────────────────────────────────────────

  const diffPreviewProvider = new DiffPreviewProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CODEBOT_PROPOSED_SCHEME,
      diffPreviewProvider
    )
  );
  context.subscriptions.push(diffPreviewProvider);

  // ── Status Bar Manager ─────────────────────────────────────────────

  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // ── Chat Sidebar Provider ──────────────────────────────────────────

  const sidebarProvider = new ChatSidebarProvider(
    context.extensionUri,
    outputChannel
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatSidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Wire agent events to the status bar
  sidebarProvider.onAgentEvent((event) => {
    statusBar.update(event);
  });

  // ── Commands ───────────────────────────────────────────────────────

  // Start a new session
  context.subscriptions.push(
    vscode.commands.registerCommand('codebot.startSession', () => {
      statusBar.reset();
      sidebarProvider.startNewSession();
      outputChannel.appendLine('[CMD] New session started');
    })
  );

  // Show usage statistics
  context.subscriptions.push(
    vscode.commands.registerCommand('codebot.showUsage', () => {
      sidebarProvider.showUsage();
    })
  );

  // Initialize a policy file in the workspace root
  context.subscriptions.push(
    vscode.commands.registerCommand('codebot.initPolicy', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage(
          'Open a workspace folder first to initialize a policy file.'
        );
        return;
      }

      const policyUri = vscode.Uri.joinPath(
        folders[0].uri,
        '.codebot',
        'policy.json'
      );

      const defaultPolicy = {
        version: '1.0',
        rules: {
          maxRiskScore: 7,
          blockedTools: [],
          requireApproval: ['file_write', 'shell_exec'],
          allowedDirectories: ['.'],
        },
      };

      try {
        await vscode.workspace.fs.writeFile(
          policyUri,
          Buffer.from(JSON.stringify(defaultPolicy, null, 2) + '\n', 'utf-8')
        );

        const doc = await vscode.workspace.openTextDocument(policyUri);
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage(
          `Policy file created at ${vscode.workspace.asRelativePath(policyUri)}`
        );
        outputChannel.appendLine(
          `[CMD] Policy file created: ${policyUri.fsPath}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Failed to create policy file: ${msg}`
        );
      }
    })
  );

  // ── Configuration Change Listener ──────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codebot')) {
        outputChannel.appendLine(
          '[CONFIG] CodeBot configuration changed. Changes will take effect on next session.'
        );
      }
    })
  );

  // ── Finalize ───────────────────────────────────────────────────────

  outputChannel.appendLine('CodeBot AI extension activated successfully.');
}

/**
 * Called when the extension is deactivated.
 * Cleanup is handled by the disposables registered in context.subscriptions.
 */
export function deactivate(): void {
  // All disposables are cleaned up automatically by VS Code
}
