// Issues Panel: activity-bar sidebar view showing GitHub + Linear issues
// scoped to the current repository.
//
// Sources:
//   GitHub  -> fetchGitHubTasks (already scoped to `gh repo view` of the workspace)
//   Linear  -> fetchLinearTasks filtered to issues with a `repo:<workspaceName>`
//              label, matching the project's existing convention
//              (see extractRepoNameFromLabels in core/tasks.ts).
//
// Refresh signals:
//   onDidChangeVisibility -> immediate fetch when the view becomes visible
//   60s poll while visible
//   manual refresh button

import * as vscode from 'vscode';
import * as path from 'path';
import { fetchAllTasks } from './tasks.vscode';
import { getSettings } from './settings.vscode';
import { UnifiedTask, extractRepoNameFromLabels } from '../core/tasks';

export const ISSUES_PANEL_VIEW_ID = 'agentsPanel.issues';

interface IssuesSnapshot {
  repoName: string | null;
  linear: UnifiedTask[];
  github: UnifiedTask[];
  loading: boolean;
  error?: string;
}

const EMPTY_SNAPSHOT: IssuesSnapshot = { repoName: null, linear: [], github: [], loading: true };

class IssuesPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private snapshot: IssuesSnapshot = EMPTY_SNAPSHOT;
  private webviewReady = false;
  private pollTimer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    view.onDidDispose(() => {
      this.stopPolling();
      this.view = undefined;
      this.webviewReady = false;
    });

    if (view.visible) {
      this.startPolling();
    }
  }

  private onMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        if (this.view) {
          this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
        }
        void this.refresh();
        return;
      case 'refresh':
        void this.refresh();
        return;
      case 'openUrl':
        if (typeof msg.url === 'string' && msg.url) {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
    }
  }

  private workspaceBasename(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.basename(root) : null;
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const repoName = this.workspaceBasename();
      const settings = getSettings(this.context);
      const { tasks } = await fetchAllTasks(this.context, settings.taskSources);

      const linear = tasks.filter((t) => {
        if (t.source !== 'linear') return false;
        if (!repoName) return true;
        const labelRepo = extractRepoNameFromLabels(t.metadata.labels);
        return labelRepo === repoName;
      });
      const github = tasks.filter((t) => t.source === 'github');

      linear.sort(sortByPriorityThenRecency);
      github.sort(sortByPriorityThenRecency);

      this.snapshot = { repoName, linear, github, loading: false };
      this.postSnapshot();
    } catch (err: any) {
      this.snapshot = { ...this.snapshot, loading: false, error: String(err?.message ?? err) };
      this.postSnapshot();
    } finally {
      this.inFlight = false;
    }
  }

  private postSnapshot(): void {
    if (this.view && this.webviewReady) {
      this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), 60_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

const PRIORITY_RANK: Record<NonNullable<UnifiedTask['priority']>, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortByPriorityThenRecency(a: UnifiedTask, b: UnifiedTask): number {
  const ra = a.priority ? PRIORITY_RANK[a.priority] : 4;
  const rb = b.priority ? PRIORITY_RANK[b.priority] : 4;
  if (ra !== rb) return ra - rb;
  const ta = a.metadata.createdAt ?? '';
  const tb = b.metadata.createdAt ?? '';
  return tb.localeCompare(ta);
}

export function registerIssuesPanel(context: vscode.ExtensionContext): void {
  const provider = new IssuesPanelProvider(context);
  // No retainContextWhenHidden: the view re-posts a full snapshot on 'ready'
  // (onMessage 'ready' -> postSnapshot + refresh) and re-fetches on reveal
  // (onDidChangeVisibility -> refresh), so a torn-down hidden webview restores
  // its state on re-show without burning CPU on a backgrounded iframe.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ISSUES_PANEL_VIEW_ID, provider),
  );
}

function renderHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 6px 8px 12px;
    margin: 0;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 2px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .header .repo {
    color: var(--vscode-foreground);
    font-weight: 500;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .header .spacer { flex: 1; }
  .refresh-btn {
    background: transparent;
    border: 1px solid var(--vscode-panel-border, transparent);
    color: var(--vscode-foreground);
    font: inherit;
    font-size: 11px;
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .refresh-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .section {
    margin-top: 4px;
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    cursor: pointer;
    user-select: none;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
  }
  .section-head:hover { color: var(--vscode-foreground); }
  .section-head .count {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 6px;
    font-size: 10px;
    letter-spacing: 0;
  }
  .section.collapsed .rows { display: none; }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px;
    padding: 5px 6px 5px 8px;
    border-left: 3px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    line-height: 1.35;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.prio-urgent { border-left-color: var(--vscode-charts-red, #c74e4e); }
  .row.prio-high   { border-left-color: var(--vscode-charts-orange, #d98c3a); }
  .row.prio-medium { border-left-color: var(--vscode-charts-yellow, #c9a227); }
  .row.prio-low    { border-left-color: var(--vscode-charts-blue, #4e8fc7); }
  .row .ident {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    white-space: nowrap;
  }
  .row .title {
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .row .meta {
    grid-column: 2;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    padding: 6px 2px;
    font-style: italic;
  }
  .error {
    color: var(--vscode-errorForeground);
    font-size: 11.5px;
    padding: 6px 2px;
  }
  .loading {
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    padding: 6px 2px;
  }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const collapsed = { linear: false, github: false };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function row(task) {
    const ident = task.metadata.identifier || '';
    const assignee = task.metadata.assignee ? '@' + task.metadata.assignee : '';
    const state = task.metadata.state || '';
    const meta = [state, assignee].filter(Boolean).join(' · ');
    const prioClass = task.priority ? ' prio-' + task.priority : '';
    const url = task.metadata.url || '';
    return (
      '<div class="row' + prioClass + '" data-url="' + esc(url) + '">' +
        '<span class="ident">' + esc(ident) + '</span>' +
        '<span class="title">' + esc(task.title) + '</span>' +
        (meta ? '<span class="meta">' + esc(meta) + '</span>' : '') +
      '</div>'
    );
  }

  function section(key, label, tasks) {
    const cls = collapsed[key] ? 'section collapsed' : 'section';
    const body = tasks.length === 0
      ? '<div class="empty">No issues for this repo.</div>'
      : tasks.map(row).join('');
    return (
      '<div class="' + cls + '" data-section="' + key + '">' +
        '<div class="section-head">' +
          '<span>' + esc(label) + '</span>' +
          '<span class="count">' + tasks.length + '</span>' +
        '</div>' +
        '<div class="rows">' + body + '</div>' +
      '</div>'
    );
  }

  function render(snap) {
    const repo = snap.repoName || 'no workspace';
    const header =
      '<div class="header">' +
        '<span>repo</span><span class="repo">' + esc(repo) + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="refresh-btn" id="refresh">Refresh</button>' +
      '</div>';

    let body = '';
    if (snap.error) {
      body = '<div class="error">' + esc(snap.error) + '</div>';
    } else if (snap.loading) {
      body = '<div class="loading">Loading issues...</div>';
    } else {
      body = section('linear', 'Linear', snap.linear) +
             section('github', 'GitHub', snap.github);
    }

    root.innerHTML = header + body;

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    root.querySelectorAll('.section-head').forEach(head => {
      head.addEventListener('click', () => {
        const sec = head.parentElement;
        const key = sec && sec.getAttribute('data-section');
        if (!key) return;
        collapsed[key] = !collapsed[key];
        sec.classList.toggle('collapsed');
      });
    });
    root.querySelectorAll('.row').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.getAttribute('data-url');
        if (url) vscode.postMessage({ type: 'openUrl', url });
      });
    });
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m && m.type === 'snapshot') render(m.data);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
