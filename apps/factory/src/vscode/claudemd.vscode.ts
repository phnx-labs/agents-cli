// VS Code-dependent CLAUDE.md functions
// Pure functions are in claudemd.ts

import * as vscode from 'vscode';
import { hasSwarmInstructions, injectSwarmInstructions } from '../core/claudemd';
import { isSwarmEnabled } from './swarm.vscode';

export async function ensureSwarmInstructions(): Promise<void> {
  // Only proceed if Swarm MCP is enabled
  const swarmEnabled = await isSwarmEnabled();
  if (!swarmEnabled) {
    console.log('[CLAUDEMD] Swarm MCP not enabled, skipping');
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;

  for (const folder of workspaceFolders) {
    const claudeMdPath = vscode.Uri.joinPath(folder.uri, 'CLAUDE.md');

    try {
      const content = await vscode.workspace.fs.readFile(claudeMdPath);
      const text = new TextDecoder().decode(content);

      if (!hasSwarmInstructions(text)) {
        const newContent = injectSwarmInstructions(text);
        await vscode.workspace.fs.writeFile(
          claudeMdPath,
          new TextEncoder().encode(newContent)
        );
        console.log(`[CLAUDEMD] Injected Swarm instructions into ${claudeMdPath.fsPath}`);
      }
    } catch {
      // File doesn't exist - skip
    }
  }
}
