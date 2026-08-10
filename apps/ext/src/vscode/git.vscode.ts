// Git commit generation - VS Code dependent functions

import * as vscode from 'vscode';
import {
  buildCommitPrompt,
  formatChangeStatus,
  parseIgnorePatterns,
  prepareCommitContext,
  shouldIgnoreFile
} from '../core/git';
import { generateCommitMessageWithClaude } from '../core/commitgen';

export async function generateCommitMessage(sourceControl?: { rootUri?: vscode.Uri }): Promise<void> {
  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  if (!gitExtension) {
    vscode.window.showErrorMessage('Git extension not found');
    return;
  }

  const gitApi = gitExtension.getAPI(1);
  if (gitApi.repositories.length === 0) {
    vscode.window.showErrorMessage('No Git repository found');
    return;
  }

  let repo = gitApi.repositories[0];

  // If triggered from SCM panel with repository context, use that repository
  if (sourceControl?.rootUri) {
    const matchingRepo = gitApi.repositories.find((r: { rootUri: vscode.Uri }) =>
      r.rootUri.toString() === sourceControl.rootUri!.toString()
    );
    if (matchingRepo) {
      repo = matchingRepo;
    }
  } else if (gitApi.repositories.length > 1) {
    // Fallback: try to detect repo from active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document.uri) {
      const activeUri = activeEditor.document.uri;
      const matchingRepo = gitApi.repositories.find((r: { rootUri: vscode.Uri }) =>
        activeUri.fsPath.startsWith(r.rootUri.fsPath)
      );
      if (matchingRepo) {
        repo = matchingRepo;
      }
    }
  }

  // If selected repo has no changes, find one that does
  const selectedHasChanges = (repo.state.workingTreeChanges || []).length > 0 ||
    (repo.state.indexChanges || []).length > 0;
  if (!selectedHasChanges && !sourceControl?.rootUri) {
    const repoWithChanges = gitApi.repositories.find((r: { state: { workingTreeChanges: unknown[]; indexChanges: unknown[] } }) => {
      const hasWorkingChanges = (r.state.workingTreeChanges || []).length > 0;
      const hasIndexChanges = (r.state.indexChanges || []).length > 0;
      return hasWorkingChanges || hasIndexChanges;
    });
    if (repoWithChanges) {
      repo = repoWithChanges;
    }
  }

  const config = vscode.workspace.getConfiguration('agents');
  const commitMessageExamples = config.get<string[]>('commitMessageExamples', []);
  const ignoreFilesRaw = config.get<string>('ignoreFiles', '');
  const disableAutopush = config.get<boolean>('disableAutopush', false);
  const disableAutocommit = config.get<boolean>('disableAutocommit', false);
  const commitGenTimeoutMs = config.get<number>('commitGenTimeoutMs', 60000);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.SourceControl,
    title: 'Generating commit...',
    cancellable: false
  }, async () => {
    try {
      const workingTreeChanges = repo.state.workingTreeChanges || [];
      const indexChanges = repo.state.indexChanges || [];

      // Filter changes based on ignore patterns
      const ignorePatterns = parseIgnorePatterns(ignoreFilesRaw);

      const filteredWorkingTreeChanges = workingTreeChanges.filter(
        (c: { uri: vscode.Uri }) => !shouldIgnoreFile(c.uri.path, ignorePatterns)
      );
      const filteredIndexChanges = indexChanges.filter(
        (c: { uri: vscode.Uri }) => !shouldIgnoreFile(c.uri.path, ignorePatterns)
      );

      const deletedPaths: string[] = [];
      const addedPaths: string[] = [];

      for (const change of [...filteredWorkingTreeChanges, ...filteredIndexChanges]) {
        const status = (change as { status: number }).status;
        const path = (change as { uri: vscode.Uri }).uri.path;

        if (status === 6) {
          deletedPaths.push(path);
        } else if (status === 7) {
          addedPaths.push(path);
        }
      }

      const unstagedStatusChanges = filteredWorkingTreeChanges.map(
        (change: { status: number; uri: vscode.Uri }) =>
          `${formatChangeStatus(change.status, false)}: ${change.uri.path}`
      ).join('\n');

      const stagedStatusChanges = filteredIndexChanges.map(
        (change: { status: number; uri: vscode.Uri }) =>
          `${formatChangeStatus(change.status, true)}: ${change.uri.path}`
      ).join('\n');

      const allStatusChanges = [unstagedStatusChanges, stagedStatusChanges].filter(s => s.length > 0).join('\n');

      const hasChanges = filteredWorkingTreeChanges.length > 0 || filteredIndexChanges.length > 0;

      if (!hasChanges) {
        vscode.window.showInformationMessage('No changes to commit.');
        return;
      }

      let unstagedDiffChanges: string | undefined;
      let stagedDiffChanges: string | undefined;
      let allDiffChanges: string | undefined;

      const commitContext = prepareCommitContext(allStatusChanges, deletedPaths, addedPaths);

      if (!commitContext.isMove) {
        unstagedDiffChanges = await repo.diff();
        stagedDiffChanges = await repo.diffWithHEAD();

        const diffParts: string[] = [];
        if (stagedDiffChanges) {
          diffParts.push(`Staged Changes:\n${stagedDiffChanges}`);
        }
        if (unstagedDiffChanges) {
          diffParts.push(`Unstaged Changes:\n${unstagedDiffChanges}`);
        }
        allDiffChanges = diffParts.join('\n\n');

        const updatedContext = prepareCommitContext(allStatusChanges, deletedPaths, addedPaths, allDiffChanges);
        commitContext.context = updatedContext.context;
        commitContext.userPrompt = updatedContext.userPrompt;
      }

      const directoryMove = commitContext.moveInfo;

      // Build prompt for OpenAI with git diff stat, first ~50 lines of diff, and examples
      const diffLines = allDiffChanges?.split('\n') || [];
      const truncatedDiff = diffLines.slice(0, 50).join('\n');
      const diffSummary = diffLines.length > 50 ? `${truncatedDiff}\n\n... (${diffLines.length - 50} more lines)` : truncatedDiff;

      const promptText = buildCommitPrompt(allStatusChanges, diffSummary, commitMessageExamples);

      const commitMessage = await generateCommitMessageWithClaude(promptText, commitGenTimeoutMs);
      if (!commitMessage) {
        throw new Error('Failed to generate commit message via `agents run claude --model haiku`. Check that the agents CLI is installed and Claude is signed in.');
      }

      repo.inputBox.value = commitMessage;

      // Stage all unstaged changes
      const allChangesToStage = [...(repo.state.workingTreeChanges || []), ...(repo.state.mergeChanges || [])];
      if (allChangesToStage.length > 0) {
        const changePaths = allChangesToStage.map((change: { uri: vscode.Uri }) => change.uri.fsPath);
        await repo.add(changePaths);
      }

      // If directory move detected, ensure all new files/dirs are staged
      if (directoryMove) {
        const stagedPaths = new Set(
          [...(repo.state.indexChanges || [])].map((change: { uri: vscode.Uri }) => change.uri.fsPath)
        );

        const newFilePaths = addedPaths
          .map(path => {
            const repoRoot = repo.rootUri.fsPath;
            const fullPath = path.startsWith('/') ? path : `${repoRoot}/${path}`;
            return fullPath;
          })
          .filter(path => {
            try {
              const fs = require('fs');
              return fs.existsSync(path) && !stagedPaths.has(path);
            } catch {
              return false;
            }
          });

        if (newFilePaths.length > 0) {
          await repo.add(newFilePaths);
        }
      }

      // Check if there are staged changes to commit
      const stagedChangesBefore = repo.state.indexChanges || [];
      const hasStagedChanges = stagedChangesBefore.length > 0 || allChangesToStage.length > 0;

      if (!hasStagedChanges) {
        vscode.window.showWarningMessage('No changes to commit.');
        return;
      }

      // If autocommit is disabled, just stage and set commit message
      if (disableAutocommit) {
        vscode.window.showInformationMessage(`Staged: ${commitMessage}`);
        return;
      }

      try {
        await repo.commit(commitMessage);

        // If autopush is disabled, skip pushing
        if (disableAutopush) {
          vscode.window.showInformationMessage(`Committed: ${commitMessage}`);
          return;
        }

        try {
          await repo.push();
          vscode.window.showInformationMessage(`Pushed: ${commitMessage}`);
        } catch (pushError: unknown) {
          // Push failed, try pull --rebase then push again
          try {
            await repo.pull(true);
            await repo.push();
            vscode.window.showInformationMessage(`Pushed (after rebase): ${commitMessage}`);
          } catch (rebaseError: unknown) {
            const msg = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
            const hasConflicts = msg.includes('conflict') || msg.includes('CONFLICT') || msg.includes('rebase');
            if (hasConflicts) {
              vscode.window.showErrorMessage('Rebase has conflicts. Resolve them manually, then run `git rebase --continue` and push.');
            } else {
              vscode.window.showErrorMessage(`Committed but push failed after rebase: ${msg}`);
            }
          }
        }
      } catch (commitError: unknown) {
        const msg = commitError instanceof Error ? commitError.message : String(commitError);
        vscode.window.showErrorMessage(`Commit failed: ${msg}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage('Error generating commit message: ' + msg);
    }
  });
}
