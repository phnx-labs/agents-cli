import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UnifiedTask, githubToUnifiedTask } from '../core/tasks';

const execFileAsync = promisify(execFile);

export async function isGitHubAvailable(_context: vscode.ExtensionContext): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detectRepo(): Promise<string | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return null;

  try {
    const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd: workspaceRoot,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface FetchGitHubTasksOptions {
  assignedOnly?: boolean; // when true, restrict to issues assigned to the current user
}

export async function fetchGitHubTasks(
  context: vscode.ExtensionContext,
  options: FetchGitHubTasksOptions = {}
): Promise<UnifiedTask[]> {
  if (!(await isGitHubAvailable(context))) return [];

  const repo = await detectRepo();
  if (!repo) return [];

  try {
    const args = [
      'issue', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '50',
      '--json', 'number,title,state,labels,assignees,url,body,createdAt',
    ];
    if (options.assignedOnly) {
      args.push('--assignee', '@me');
    }

    const { stdout } = await execFileAsync('gh', args, { timeout: 15000 });
    const issues: any[] = JSON.parse(stdout);

    return issues.map(issue => githubToUnifiedTask({
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state?.toLowerCase() || 'open',
      html_url: issue.url,
      labels: issue.labels,
      assignee: issue.assignees?.[0],
      createdAt: issue.createdAt,
    }, repo));
  } catch (err) {
    console.error('[GITHUB] Error fetching tasks:', err);
    return [];
  }
}

export function clearGitHubCache(): void {
  // No cache to clear with CLI approach
}
