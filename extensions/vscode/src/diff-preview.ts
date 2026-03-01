import * as vscode from 'vscode';
import * as path from 'path';

/**
 * URI scheme used for proposed (modified) file content in diff views.
 */
export const CODEBOT_PROPOSED_SCHEME = 'codebot-proposed';

/**
 * Provides virtual document content for the "proposed" side of diff views.
 * Stores proposed file contents in memory, keyed by file path.
 */
export class DiffPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly proposedContents = new Map<string, string>();

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  /**
   * Called by VS Code to provide content for a `codebot-proposed:` URI.
   */
  public provideTextDocumentContent(uri: vscode.Uri): string {
    const filePath = uri.path;
    return this.proposedContents.get(filePath) ?? '';
  }

  /**
   * Stores proposed content for a file path and notifies VS Code of the change.
   */
  public setProposedContent(filePath: string, content: string): void {
    this.proposedContents.set(filePath, content);

    const uri = vscode.Uri.parse(
      `${CODEBOT_PROPOSED_SCHEME}:${filePath}`
    );
    this._onDidChange.fire(uri);
  }

  /**
   * Removes stored proposed content for a file path.
   */
  public clearProposedContent(filePath: string): void {
    this.proposedContents.delete(filePath);
  }

  /**
   * Clears all stored proposed content.
   */
  public clearAll(): void {
    this.proposedContents.clear();
  }

  /**
   * Opens a VS Code diff editor comparing the original file on disk
   * with the proposed (modified) content.
   *
   * @param filePath - Absolute path to the original file
   * @param proposedContent - The proposed/modified file content
   */
  public static async showDiff(
    provider: DiffPreviewProvider,
    filePath: string,
    proposedContent: string
  ): Promise<void> {
    // Store the proposed content
    provider.setProposedContent(filePath, proposedContent);

    // Build URIs for both sides of the diff
    const originalUri = vscode.Uri.file(filePath);
    const proposedUri = vscode.Uri.parse(
      `${CODEBOT_PROPOSED_SCHEME}:${filePath}`
    );

    const fileName = path.basename(filePath);
    const title = `${fileName} (Original \u2194 CodeBot Proposed)`;

    // Open the diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      title,
      { preview: true }
    );
  }

  /**
   * Disposes of the event emitter.
   */
  public dispose(): void {
    this._onDidChange.dispose();
    this.proposedContents.clear();
  }
}
