// Git commit generation - pure functions (testable)

// Parse ignore patterns from comma-separated string
export function parseIgnorePatterns(ignoreFilesRaw: string): string[] {
  if (!ignoreFilesRaw) return [];
  return ignoreFilesRaw.split(',').map(p => p.trim()).filter(Boolean);
}

// Check if a file path should be ignored based on patterns
export function shouldIgnoreFile(filePath: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      return filePath.endsWith(pattern.slice(1));
    }
    return filePath.includes(`/${pattern}/`) || filePath.includes(`/${pattern}`) || filePath.endsWith(`/${pattern}`);
  });
}

// Format git status for a change
export function formatChangeStatus(status: number, staged: boolean): string {
  const statusText = status === 7 ? 'New' :
    status === 5 ? 'Modified' :
      status === 6 ? 'Deleted' : 'Changed';
  return staged ? `Staged ${statusText}` : `Unstaged ${statusText}`;
}

export interface DirectoryMove {
  fromPrefix: string;
  toPrefix: string;
  fileCount: number;
  dirName: string;
}

export function detectDirectoryMoves(
  deletedPaths: string[],
  addedPaths: string[],
  minMatchThreshold: number = 5
): DirectoryMove | null {
  if (deletedPaths.length < minMatchThreshold || addedPaths.length < minMatchThreshold) {
    return null;
  }

  const addedSet = new Set(addedPaths);
  const deletedByPrefix = new Map<string, string[]>();

  for (const deletedPath of deletedPaths) {
    const parts = deletedPath.split('/').filter(Boolean);
    if (parts.length < 2) continue;

    for (let i = 1; i <= parts.length - 1; i++) {
      const prefix = parts.slice(0, i).join('/') + '/';
      if (!deletedByPrefix.has(prefix)) {
        deletedByPrefix.set(prefix, []);
      }
      deletedByPrefix.get(prefix)!.push(deletedPath);
    }
  }

  for (const [prefix, deletedFiles] of deletedByPrefix.entries()) {
    if (deletedFiles.length < minMatchThreshold) continue;

    const relativePaths = deletedFiles.map(path => {
      if (path.startsWith(prefix)) {
        return path.slice(prefix.length);
      }
      return path;
    });

    let matchCount = 0;
    for (const relPath of relativePaths) {
      if (addedSet.has(relPath)) {
        matchCount++;
      }
    }

    if (matchCount >= minMatchThreshold) {
      const prefixParts = prefix.split('/').filter(Boolean);
      const dirName = prefixParts[prefixParts.length - 1];
      return {
        fromPrefix: prefix,
        toPrefix: '',
        fileCount: matchCount,
        dirName: dirName
      };
    }

    const prefixParts = prefix.split('/').filter(Boolean);
    if (prefixParts.length >= 2) {
      const parentPrefix = prefixParts.slice(0, -1).join('/') + '/';
      matchCount = 0;

      for (const relPath of relativePaths) {
        const parentPath = parentPrefix + relPath;
        if (addedSet.has(parentPath)) {
          matchCount++;
        }
      }

      if (matchCount >= minMatchThreshold) {
        const dirName = prefixParts[prefixParts.length - 1];
        return {
          fromPrefix: prefix,
          toPrefix: parentPrefix,
          fileCount: matchCount,
          dirName: dirName
        };
      }
    }
  }

  return null;
}

export function summarizeDiff(diff: string): string {
  if (!diff) return '';

  const lines = diff.split('\n');
  let output = '';
  
  const fileBlocks: string[][] = [];
  let currentBlock: string[] = [];
  
  for (const line of lines) {
      if (line.startsWith('diff --git ')) {
          if (currentBlock.length > 0) {
              fileBlocks.push(currentBlock);
          }
          currentBlock = [line];
      } else {
          currentBlock.push(line);
      }
  }
  if (currentBlock.length > 0) {
      fileBlocks.push(currentBlock);
  }
  
  for (const block of fileBlocks) {
      if (!block[0].startsWith('diff --git ')) {
          continue; 
      }
      
      let filePath = '';
      const plusLine = block.find(l => l.startsWith('+++ b/'));
      if (plusLine) {
          filePath = plusLine.substring(6);
      } else {
           const minusLine = block.find(l => l.startsWith('--- a/'));
           if (minusLine) filePath = minusLine.substring(6);
           else {
               const parts = block[0].split(' ');
               if (parts.length >= 4) {
                   const bPart = parts[parts.length-1];
                   if (bPart.startsWith('b/')) filePath = bPart.substring(2);
                   else filePath = bPart;
               }
           }
      }
      
      if (!filePath) continue;
      
      let added = 0;
      let removed = 0;
      const preview: string[] = [];
      let inHunk = false;
      
      for (const line of block) {
          if (line.startsWith('@@ ')) {
              inHunk = true;
              continue; 
          }
          
          if (!inHunk) continue;
          
          if (line.startsWith('+') && !line.startsWith('+++')) {
              added++;
              if (preview.length < 10) preview.push(line);
          } else if (line.startsWith('-') && !line.startsWith('---')) {
              removed++;
              if (preview.length < 10) preview.push(line);
          } else if (line.startsWith(' ')) {
               if (preview.length < 10) preview.push(line);
          }
      }
      
      output += `File: ${filePath} (${added + removed} lines changed)\n`;
      output += preview.join('\n');
      if (preview.length > 0 && (preview.length < (added + removed) || preview.length === 10)) { 
           output += '\n...';
      } else if (preview.length === 0 && (added + removed) > 0) {
           output += '\n...';
      }
      output += '\n\n';
  }
  
  return output.trim();
}

export interface CommitContext {
  context: string;
  userPrompt: string;
  isMove: boolean;
  moveInfo?: DirectoryMove;
}

const MAX_CONTEXT_SIZE = 50 * 1024;
const MAX_STATUS_FILES = 100;

// Build the prompt sent to Claude CLI for commit message generation.
// Style rules mirror ~/.agents-system/commands/commit.md.
export function buildCommitPrompt(
  statusChanges: string,
  diffSummary: string,
  commitMessageExamples: string[]
): string {
  const examplesSection = commitMessageExamples.length > 0
    ? `\n\nStyle examples (match the voice):\n${commitMessageExamples.map(ex => `- ${ex}`).join('\n')}`
    : '';

  return `Write ONE conventional-commit message for the staged changes below.

Respond IMMEDIATELY with only the commit message. Do NOT investigate, do NOT read files, do NOT use tools.

Format: <type>: <description>
Types: feat, fix, docs, refactor, test, build, release, chore

Rules:
- Single line, under 72 characters.
- Lowercase. Imperative mood ("add", "fix", "update" — not "added", "fixes").
- No body, no trailers, no Co-Authored-By, no "Generated with" lines.
- No scope prefix like feat(api): — just feat:.
- No emojis. No quotes around the message. No leading/trailing punctuation.

Git status:
${statusChanges}

${diffSummary ? `Diff preview:\n${diffSummary}` : ''}${examplesSection}

Output the commit message and nothing else.`;
}

export function prepareCommitContext(
  statusChanges: string,
  deletedPaths: string[],
  addedPaths: string[],
  diffChanges?: string
): CommitContext {
  const directoryMove = detectDirectoryMoves(deletedPaths, addedPaths);
  const statusLines = statusChanges.split('\n').filter(Boolean);

  let context: string;
  let userPrompt: string;

  if (directoryMove) {
    const moveSummary = `${directoryMove.fileCount} files in dir ${directoryMove.dirName} moved from ${directoryMove.fromPrefix} to ${directoryMove.toPrefix || 'root'}`;

    let truncatedStatus = statusChanges;
    if (statusLines.length > MAX_STATUS_FILES) {
      const truncatedLines = statusLines.slice(0, MAX_STATUS_FILES);
      const remaining = statusLines.length - MAX_STATUS_FILES;
      truncatedStatus = truncatedLines.join('\n') + `\n... and ${remaining} more files`;
    }

    context = `Status:\n${truncatedStatus}\n\nMove detected: ${moveSummary}`;
    userPrompt = `Review the following git status and generate a concise commit message:\n\n${context}`;
  } else {
    let truncatedStatus = statusChanges;
    if (statusLines.length > MAX_STATUS_FILES) {
      const truncatedLines = statusLines.slice(0, MAX_STATUS_FILES);
      const remaining = statusLines.length - MAX_STATUS_FILES;
      truncatedStatus = truncatedLines.join('\n') + `\n... and ${remaining} more files`;
    }

    let diffSummary = '';
    if (diffChanges) {
        diffSummary = summarizeDiff(diffChanges);
    }

    const fullChanges = `Status:\n${truncatedStatus}${diffSummary ? `\n\nDiff Summary:\n${diffSummary}` : ''}`;

    context = fullChanges;

    // We can probably relax MAX_CONTEXT_SIZE or keep it as a safety net.
    // Given the summarization, it's less likely to overflow, but if it does, we just truncate the end.
    if (context.length > MAX_CONTEXT_SIZE) {
      const truncated = context.slice(0, MAX_CONTEXT_SIZE - 100) + '\n... (context truncated)';
      context = truncated;
    }

    userPrompt = `Review the following git status + diff summary and generate a concise commit message:\n\n${context}`;
  }

  return {
    context,
    userPrompt,
    isMove: !!directoryMove,
    moveInfo: directoryMove || undefined
  };
}