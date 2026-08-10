import * as vscode from 'vscode';
import { isAllowedExternalUrl, isAllowedWebviewCommand } from '../core/webviewSecurity';

export { isAllowedWebviewCommand };

// Open a webview-supplied URL externally, but only if it parses and carries an
// allowed scheme (see src/core/webviewSecurity). Silently drops empty/non-string
// values; warns on a blocked scheme so the drop is visible rather than mysterious.
export function openExternalUrl(rawUrl: unknown): void {
  if (!isAllowedExternalUrl(rawUrl)) {
    if (typeof rawUrl === 'string' && rawUrl) {
      void vscode.window.showWarningMessage('Blocked opening a URL with a disallowed scheme.');
    }
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(rawUrl as string));
}
