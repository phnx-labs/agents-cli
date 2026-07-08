// Notifications MCP configuration - VS Code dependent functions

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

// Check if Notifications MCP server is configured
export async function isNotificationsEnabled(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('claude mcp list');
    return stdout.includes('Notifications');
  } catch {
    return false;
  }
}

// Find the bundled alerter binary
function findBundledAlerter(extensionPath: string): string | null {
  const alerterPath = path.join(extensionPath, 'assets', 'alerter');
  if (fs.existsSync(alerterPath)) {
    return alerterPath;
  }
  return null;
}

// Find the bundled notifications-mcp binary
function findBundledMcp(extensionPath: string): string | null {
  const mcpPath = path.join(extensionPath, 'mcp', 'notifications', 'dist', 'index.js');
  if (fs.existsSync(mcpPath)) {
    return mcpPath;
  }
  return null;
}

// Find the bundled Claude icon
function findClaudeIcon(extensionPath: string): string | null {
  const iconPath = path.join(extensionPath, 'assets', 'claude.png');
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }
  return null;
}

export async function enableNotifications(context: vscode.ExtensionContext): Promise<void> {
  // Check if already enabled
  if (await isNotificationsEnabled()) {
    vscode.window.showInformationMessage('Notifications MCP is already enabled.');
    return;
  }

  const extensionPath = context.extensionPath;

  // Find bundled alerter
  const alerterPath = findBundledAlerter(extensionPath);
  if (!alerterPath) {
    vscode.window.showErrorMessage(
      'alerter binary not found in extension. Please reinstall the extension.'
    );
    return;
  }

  // Find bundled MCP server
  const mcpPath = findBundledMcp(extensionPath);
  if (!mcpPath) {
    vscode.window.showErrorMessage(
      'notifications-mcp not found in extension. Please reinstall the extension.'
    );
    return;
  }

  // Ensure alerter is executable
  try {
    fs.chmodSync(alerterPath, '755');
  } catch (err) {
    console.error('Failed to chmod alerter:', err);
  }

  // Find Claude icon for notifications
  const claudeIconPath = findClaudeIcon(extensionPath);

  try {
    // Register the MCP server with Claude Code
    // Use node to run the MCP server, passing ALERTER_PATH and CLAUDE_ICON_PATH as env vars
    let addCmd = `claude mcp add --scope user Notifications node "${mcpPath}" --env ALERTER_PATH="${alerterPath}"`;
    if (claudeIconPath) {
      addCmd += ` --env CLAUDE_ICON_PATH="${claudeIconPath}"`;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Enabling Notifications MCP...',
        cancellable: false,
      },
      async () => {
        await execAsync(addCmd);
      }
    );

    vscode.window.showInformationMessage(
      'Notifications MCP installed. Reload Claude Code to use mcp__Notifications__ask_permission.'
    );
  } catch (err) {
    const error = err as Error & { stderr?: string };
    vscode.window.showErrorMessage(
      `Failed to enable Notifications MCP: ${error.stderr || error.message}`
    );
  }
}
