// Pure types for unified task management across multiple sources
// No VS Code dependencies - testable

// UnifiedTask / TaskMetadata / TaskComment / TaskSource are canonical in
// src/shared/tasks.ts — the ONE definition shared with the webview (@shared), so a
// field (e.g. `project`) can never be present on one side of the postMessage
// boundary and missing on the other. Imported for local use here + re-exported for
// existing consumers.
import type { TaskSource, UnifiedTask, TaskMetadata, TaskComment } from '../shared/tasks';
export type { UnifiedTask, TaskMetadata, TaskComment, TaskSource };

export interface TaskDispatchPromptInput {
  title: string;
  description?: string;
  identifier?: string;
  url?: string;
  extraComments?: string;
}

function cleanPromptPart(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function buildTaskDispatchPrompt(input: TaskDispatchPromptInput): string {
  const parts: string[] = [];
  const title = cleanPromptPart(input.title);
  const description = cleanPromptPart(input.description);
  const identifier = cleanPromptPart(input.identifier);
  const url = cleanPromptPart(input.url);
  const extraComments = cleanPromptPart(input.extraComments);

  if (title) parts.push(title);
  if (description) parts.push(description);
  if (identifier) parts.push(`Reference: ${identifier}`);
  if (url) parts.push(`URL: ${url}`);
  if (extraComments) parts.push(`Additional instructions:\n${extraComments}`);

  return parts.join('\n\n');
}

// A Linear user whose name matches one of these is treated as an agent, so the
// card renders an agent chip rather than a @mention. Case-insensitive match.
const AGENT_ASSIGNEE_PATTERN = /^(claude|codex|gemini|cursor|opencode)$/i;

export function detectAssigneeKind(name: string | undefined | null): 'user' | 'agent' | undefined {
  if (!name) return undefined;
  return AGENT_ASSIGNEE_PATTERN.test(name.trim()) ? 'agent' : 'user';
}

// Extract the first repo:<name> label value. Pure — does not resolve owner.
// Callers combine with an owner (resolved in the VS Code layer) to form owner/repo.
export function extractRepoNameFromLabels(labels: string[] | undefined): string | null {
  if (!labels) return null;
  for (const raw of labels) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim().match(/^repo:([A-Za-z0-9._-]+)$/);
    if (m) return m[1];
  }
  return null;
}

// Markdown image: ![alt](url) or ![alt](url "title")
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
// HTML image: <img src="url"> / <img src='url'>
const HTML_IMAGE_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

// Extract embedded image URLs from a markdown/HTML body. Pure. Returns deduped,
// order-preserving http(s) URLs only. Linear uploads and GitHub issue images both
// embed as markdown `![](…)` or raw `<img>` in the body, so scanning the body is
// the source of image URLs available at fetch time.
export function extractImageUrls(...bodies: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of bodies) {
    if (!body) continue;
    for (const re of [MARKDOWN_IMAGE_RE, HTML_IMAGE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const url = m[1].trim();
        if (!/^https?:\/\//i.test(url)) continue; // sanitize: no data:/javascript: URLs
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}

// Active cycle info from Linear
export interface CycleInfo {
  name: string;
  startsAt: string;              // ISO 8601
  endsAt: string;                // ISO 8601
}

// Source badge display info
export const SOURCE_BADGES: Record<TaskSource, { label: string; color: string }> = {
  linear: { label: 'LN', color: '#5e6ad2' },    // Linear purple
  github: { label: 'GH', color: '#238636' }     // GitHub green
};

// Convert Linear issue to UnifiedTask.
// `repo` is the pre-resolved "owner/name" string (caller resolves owner), or null.
export function linearToUnifiedTask(
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    state: { name: string; type: string };
    priority: number;
    url: string;
    labels?: { nodes: { name: string }[] };
    assignee?: { name: string };
    project?: { name: string } | null;
    dueDate?: string | null;
    createdAt?: string;
    comments?: { nodes: { body: string; createdAt?: string; user?: { name: string } | null }[] };
  },
  repo: string | null = null,
): UnifiedTask {
  // Map Linear priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)
  const priorityMap: Record<number, UnifiedTask['priority']> = {
    1: 'urgent',
    2: 'high',
    3: 'medium',
    4: 'low'
  };

  // Map Linear state type to our status
  const statusMap: Record<string, UnifiedTask['status']> = {
    backlog: 'todo',
    unstarted: 'todo',
    started: 'in_progress',
    completed: 'done',
    canceled: 'done'
  };

  const labels = issue.labels?.nodes.map(l => l.name);
  const assignee = issue.assignee?.name;
  const comments: TaskComment[] | undefined = issue.comments?.nodes.map(n => ({
    body: n.body,
    createdAt: n.createdAt,
    author: n.user?.name,
  }));

  const images = extractImageUrls(issue.description, ...(comments?.map(c => c.body) ?? []));

  return {
    id: `linear:${issue.id}`,
    source: 'linear',
    title: issue.title,
    description: issue.description,
    status: statusMap[issue.state.type] || 'todo',
    priority: priorityMap[issue.priority],
    metadata: {
      identifier: issue.identifier,
      url: issue.url,
      labels,
      assignee,
      assigneeKind: detectAssigneeKind(assignee),
      state: issue.state.name,
      createdAt: issue.createdAt,
      dueDate: issue.dueDate ?? undefined,
      project: issue.project?.name ?? undefined,
      repo: repo ?? undefined,
      comments,
      images: images.length > 0 ? images : undefined,
    }
  };
}

// Convert GitHub issue to UnifiedTask. `repo` is the detected "owner/name".
export function githubToUnifiedTask(
  issue: {
    id: number;
    number: number;
    title: string;
    body?: string;
    state: string;
    html_url: string;
    labels?: { name: string }[];
    assignee?: { login: string };
    createdAt?: string;
  },
  repo: string | null = null,
): UnifiedTask {
  const assignee = issue.assignee?.login;
  const images = extractImageUrls(issue.body);
  return {
    id: `github:${issue.id}`,
    source: 'github',
    title: issue.title,
    description: issue.body,
    status: issue.state === 'closed' ? 'done' : 'todo',
    metadata: {
      identifier: `#${issue.number}`,
      url: issue.html_url,
      labels: issue.labels?.map(l => l.name),
      assignee,
      assigneeKind: detectAssigneeKind(assignee),
      state: issue.state,
      createdAt: issue.createdAt,
      repo: repo ?? undefined,
      images: images.length > 0 ? images : undefined,
    }
  };
}

// Group tasks by source
export function groupTasksBySource(tasks: UnifiedTask[]): Map<TaskSource, UnifiedTask[]> {
  const groups = new Map<TaskSource, UnifiedTask[]>();
  for (const task of tasks) {
    const existing = groups.get(task.source) || [];
    existing.push(task);
    groups.set(task.source, existing);
  }
  return groups;
}

// Filter tasks by status
export function filterTasksByStatus(
  tasks: UnifiedTask[],
  statuses: UnifiedTask['status'][]
): UnifiedTask[] {
  return tasks.filter(t => statuses.includes(t.status));
}
