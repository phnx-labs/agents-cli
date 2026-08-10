// Shared task types — the SINGLE source of truth for the unified backlog,
// imported by BOTH the extension host (src/*) and the webview (ui/* via the
// `@shared` vite alias). Do not re-declare these on either side: a hand-mirrored
// copy is exactly how the `project` field silently vanished across the
// postMessage boundary (the blank "Group by Project" header). Pure types only —
// no vscode/node imports, so the webview bundle stays clean.

export type TaskSource = 'linear' | 'github';

export interface TaskComment {
  body: string;
  createdAt?: string;
  author?: string;
}

// Source-specific metadata. Superset of what either side needs; unused fields are
// simply absent per source (e.g. `project` is Linear-only, `file`/`line` are for
// code-TODO sources).
export interface TaskMetadata {
  file?: string;                 // code-TODO source: file path
  line?: number;                 // code-TODO source: line number
  identifier?: string;           // Linear: PROJ-123, GitHub: #42
  url?: string;                  // Web URL to task
  labels?: string[];             // Labels/tags
  assignee?: string;             // Assigned user
  assigneeKind?: 'user' | 'agent'; // 'agent' if name matches a known CLI agent
  state?: string;                // Raw state from source
  createdAt?: string;            // ISO 8601 creation timestamp
  dueDate?: string;              // ISO 8601 due date (YYYY-MM-DD from Linear)
  project?: string;              // Linear project name (undefined for GitHub)
  repo?: string;                 // "owner/repo" — resolved at fetch time
  comments?: TaskComment[];      // Linear comments, newest-first when rendered
  images?: string[];             // Image URLs embedded in the body/comments (deduped, http(s) only)
}

// Unified task interface for aggregating tasks from multiple sources.
export interface UnifiedTask {
  id: string;                    // Unique identifier
  source: TaskSource;            // Where this task came from
  title: string;                 // Task title/summary
  description?: string;          // Optional description/body
  status: 'todo' | 'in_progress' | 'done';
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  metadata: TaskMetadata;        // Source-specific data
}
