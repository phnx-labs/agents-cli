// Pure shaper for the Foreman `cycle` tool. Given the raw UnifiedTask list +
// active CycleInfo, produces a voice-friendly summary: cycle name, days left,
// counts, and the top 5 pending tickets (priority-ranked, in_progress before
// todo at ties).

import { UnifiedTask, CycleInfo } from './tasks';

export interface CycleSummary {
  cycle_name: string | null;
  cycle_days_left: number | null;
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  urgent: number;
  high: number;
  top: Array<{
    id: string;
    title: string;
    priority: string | null;
    status: 'todo' | 'in_progress' | 'done';
    assignee: string | null;
  }>;
}

const DAY_MS = 86_400_000;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function summarizeCycle(
  tasks: UnifiedTask[],
  cycleInfo: CycleInfo | null
): CycleSummary {
  const daysLeft = cycleInfo?.endsAt
    ? Math.max(0, Math.ceil((Date.parse(cycleInfo.endsAt) - Date.now()) / DAY_MS))
    : null;

  const todo = tasks.filter((t) => t.status === 'todo').length;
  const in_progress = tasks.filter((t) => t.status === 'in_progress').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const urgent = tasks.filter((t) => t.priority === 'urgent').length;
  const high = tasks.filter((t) => t.priority === 'high').length;

  const top = tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => {
      const ap = PRIORITY_RANK[a.priority ?? ''] ?? 4;
      const bp = PRIORITY_RANK[b.priority ?? ''] ?? 4;
      if (ap !== bp) return ap - bp;
      if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1;
      return 0;
    })
    .slice(0, 5)
    .map((t) => ({
      id: t.metadata.identifier ?? t.id,
      title: t.title,
      priority: t.priority ?? null,
      status: t.status,
      assignee: t.metadata.assignee ?? null,
    }));

  return {
    cycle_name: cycleInfo?.name ?? null,
    cycle_days_left: daysLeft,
    total: tasks.length,
    todo,
    in_progress,
    done,
    urgent,
    high,
    top,
  };
}
