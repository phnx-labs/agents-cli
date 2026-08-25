export type TraceTopicGroup = 'code' | 'research' | 'review' | 'content' | 'ops';
export type TraceFailureCause = 'real' | 'guard' | 'hook';

/** Per-bucket aggregate stats for one day, stored in the rolling bucketHistory. */
export interface BucketStats {
  key: string;
  date: string;
  count: number;
  /** Tool-error count / total tool calls in this session set (0–1). */
  errorRate: number;
  /** Sessions with ≥1 stall friction signal / total sessions in bucket (0–1). */
  stallRate: number;
}

/** Movement signal for one topic bucket compared to its 7-day rolling average. */
export interface DriftSignal {
  bucket: string;
  /** current errorRate − 7d average (positive = degrading). */
  errorDelta: number;
  /** current stallRate − 7d average (positive = degrading). */
  stallDelta: number;
  severity: 'degrading' | 'stable' | 'improving';
}

export interface TopicEvidence {
  cwd?: string | null;
  gitBranch?: string | null;
  topic?: string | null;
  label?: string | null;
  toolMix?: Record<string, number>;
}

export interface ClassifiedTopic {
  group: TraceTopicGroup;
  key: string;
  label: string;
}

export interface ToolCallFailure {
  tool: string;
  exit_code?: number | null;
  status_code?: number | null;
  error_code?: string | null;
  error?: string | null;
  parse_error?: string | null;
  outcome?: string | null;
}

function normalizedEvidence(input: TopicEvidence): string {
  return [input.cwd, input.gitBranch, input.topic, input.label]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/** Classify a session from metadata and aggregate tool names; never reads transcript text. */
export function classifyTopic(input: TopicEvidence): ClassifiedTopic {
  const text = normalizedEvidence(input);
  const tools = Object.keys(input.toolMix ?? {}).map((tool) => tool.toLowerCase());
  const hasTool = (pattern: RegExp): boolean => tools.some((tool) => pattern.test(tool));

  if (/\b(review|audit|pr[-_/ ]?review|code[-_/ ]?review)\b/.test(text)
      || hasTool(/review|comment/)) {
    return { group: 'review', key: 'code-review', label: 'Code review' };
  }
  if (/\b(research|investigat|analysis|benchmark|paper|docs?)\b/.test(text)
      || hasTool(/web_search|search_query|webfetch|browser/)) {
    return { group: 'research', key: 'research', label: 'Research' };
  }
  if (/\b(blog|copy|content|post|article|script|caption)\b/.test(text)) {
    return { group: 'content', key: 'content', label: 'Content' };
  }
  if (/\b(deploy|release|infra|ci|ops|fleet|daemon|provision)\b/.test(text)
      || hasTool(/ssh|deploy|computer/)) {
    return { group: 'ops', key: 'operations', label: 'Operations' };
  }
  if (/\b(test|fix|bug|feat|refactor|implement|code)\b/.test(text)
      || hasTool(/edit|write|apply_patch|exec|bash|shell/)) {
    return { group: 'code', key: 'engineering', label: 'Engineering' };
  }
  return { group: 'research', key: 'general', label: 'General' };
}

/** Bucket a failed tool call without inspecting raw tool input or transcript text. */
export function classifyCause(call: ToolCallFailure): TraceFailureCause {
  const evidence = [call.error_code, call.error, call.parse_error]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(?:git-guard|main-branch-guard)\b/.test(evidence)) return 'guard';
  if (/permission\b.*\bdenied\b.*\b(?:auto[- ]mode|classifier)\b/.test(evidence)) {
    return 'hook';
  }
  return 'real';
}

const DRIFT_THRESHOLD = 0.20;

/**
 * Compare today's per-bucket stats to the last 7 days of history and return
 * movement signals. Buckets with fewer than 3 historical days are skipped —
 * not enough signal to distinguish noise from drift.
 */
export function computeDriftSignal(
  history: BucketStats[][],
  today: BucketStats[],
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  for (const stat of today) {
    const pastStats = history
      .flatMap((day) => day.filter((b) => b.key === stat.key))
      .slice(-7);
    if (pastStats.length < 3) continue;
    const avgError = pastStats.reduce((sum, b) => sum + b.errorRate, 0) / pastStats.length;
    const avgStall = pastStats.reduce((sum, b) => sum + b.stallRate, 0) / pastStats.length;
    const errorDelta = stat.errorRate - avgError;
    const stallDelta = stat.stallRate - avgStall;
    const severity: DriftSignal['severity'] =
      errorDelta > DRIFT_THRESHOLD || stallDelta > DRIFT_THRESHOLD
        ? 'degrading'
        : errorDelta < -DRIFT_THRESHOLD || stallDelta < -DRIFT_THRESHOLD
        ? 'improving'
        : 'stable';
    signals.push({ bucket: stat.key, errorDelta, stallDelta, severity });
  }
  return signals.sort((a, b) => b.errorDelta - a.errorDelta);
}
