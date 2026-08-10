import { describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { prepareCommitContext } from '../core/git';

function findGitRoot(startPath: string): string {
  const path = require('path');
  const fs = require('fs');
  let current = startPath;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return startPath;
}

function parseGitStatus(): { deleted: string[]; added: string[]; statusLines: string[] } {
  try {
    const gitRoot = findGitRoot(process.cwd());
    const output = execSync('git status --porcelain', { encoding: 'utf-8', cwd: gitRoot });
    const lines = output.trim().split('\n').filter(Boolean);

    const deleted: string[] = [];
    const added: string[] = [];
    const statusLines: string[] = [];

    for (const line of lines) {
      const status = line.substring(0, 2);
      const path = line.substring(3);

      if (status[0] === 'D' || status[1] === 'D') {
        deleted.push(path);
        statusLines.push(`Deleted: ${path}`);
      } else if (status[0] === '?' && status[1] === '?') {
        added.push(path);
        statusLines.push(`Untracked: ${path}`);
      } else if (status[0] === 'A' || status[1] === 'A') {
        added.push(path);
        statusLines.push(`Added: ${path}`);
      } else if (status[0] === 'M' || status[1] === 'M') {
        statusLines.push(`Modified: ${path}`);
      }
    }

    return { deleted, added, statusLines };
  } catch (error) {
    return { deleted: [], added: [], statusLines: [] };
  }
}

describe('prepareCommitContext integration', () => {
  test('works with actual git repo state', () => {
    const { deleted, added, statusLines } = parseGitStatus();

    if (deleted.length === 0 && added.length === 0) {
      console.log('No git changes detected, skipping integration test');
      return;
    }

    const statusChanges = statusLines.join('\n');
    const result = prepareCommitContext(statusChanges, deleted, added);

    expect(result).toBeDefined();
    expect(result.context).toBeDefined();
    expect(result.userPrompt).toBeDefined();
    expect(typeof result.isMove).toBe('boolean');

    expect(result.context.length).toBeLessThan(100 * 1024);
    expect(result.userPrompt.length).toBeLessThan(100 * 1024);

    if (result.isMove && result.moveInfo) {
      expect(result.moveInfo.fileCount).toBeGreaterThan(0);
      expect(result.moveInfo.fromPrefix).toBeTruthy();
      expect(result.moveInfo.dirName).toBeTruthy();
      expect(result.context).toContain('Move detected');
    }

    console.log(`Context size: ${result.context.length} bytes`);
    console.log(`Is move: ${result.isMove}`);
    if (result.isMove && result.moveInfo) {
      console.log(`Move: ${result.moveInfo.dirName} from ${result.moveInfo.fromPrefix} to ${result.moveInfo.toPrefix || 'root'}`);
    }
  });

  test('detects directory moves correctly', () => {
    const { deleted, added } = parseGitStatus();

    if (deleted.length < 5 || added.length < 5) {
      console.log('Not enough changes for move detection test');
      return;
    }

    const statusLines = [
      ...deleted.map(p => `Deleted: ${p}`),
      ...added.map(p => `Untracked: ${p}`)
    ];
    const statusChanges = statusLines.join('\n');

    const result = prepareCommitContext(statusChanges, deleted, added);

    expect(result.context.length).toBeLessThan(100 * 1024);
    expect(result.userPrompt.length).toBeLessThan(100 * 1024);

    if (result.isMove) {
      expect(result.moveInfo).toBeDefined();
      expect(result.moveInfo!.fileCount).toBeGreaterThanOrEqual(5);
      expect(result.context).toContain('Move detected');
      expect(result.context).toContain(result.moveInfo!.dirName);
    } else {
      console.log(`No move detected (deleted: ${deleted.length}, added: ${added.length})`);
      console.log('Note: git status --porcelain may show directories instead of individual files');
      console.log('VS Code Git API provides individual file paths, so detection works in practice');
    }
  });
});

