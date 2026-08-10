#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_BASENAME = '00-agent-verify-work-complete.sh';
const FEEDBACK_PREFIX = 'Stop hook feedback:';
const DEDUPE_MS = 5_000;

export type TimelineEvent = {
  index: number;
  timestamp: string;
  kind: 'message' | 'tool';
  role?: 'user' | 'assistant';
  text?: string;
  tool?: string;
  command?: string;
  synthetic?: boolean;
};

export type GateType =
  | 'open-pr'
  | 'delivery'
  | 'keep-moving'
  | 'handback'
  | 'swarm'
  | 'self-audit'
  | 'other';

export type Reaction =
  | 'productive-action'
  | 'substantiated-pushback'
  | 'unsupported-pushback'
  | 'blocker-or-handoff'
  | 'verbal-compliance'
  | 'no-assistant-reaction'
  | 'other';

type SessionMeta = {
  id: string;
  shortId?: string;
  agent: string;
  version?: string;
  machine?: string;
  timestamp?: string;
  lastActivity?: string;
  filePath: string;
  project?: string;
};

export type Intervention = {
  sessionKey: string;
  sessionId: string;
  agent: string;
  version: string;
  machine: string;
  project: string;
  timestamp: string;
  gate: GateType;
  logicalAttempt: number;
  rawDuplicateCount: number;
  reaction: Reaction;
  repeatedBeforeUser: boolean;
  productiveToolCount: number;
  deliveryContextMismatchCandidate: boolean;
  priorAssistant: string;
  feedback: string;
  nextAssistant: string;
  tools: Array<{ tool: string; command: string }>;
};

type InstallAudit = {
  systemRepo: string;
  manifestRegistered: boolean;
  sourcePresent: boolean;
  sourceSha256: string;
  harnesses: Array<{
    harness: 'claude' | 'codex';
    activeCopyPresent: boolean;
    activeCopyMatchesSource: boolean;
    activeRegistrations: number;
    managedCopies: number;
    managedCopiesMatchingSource: number;
  }>;
};

export type AuditResult = {
  generatedAt: string;
  window: { since: string; start: string; end: string };
  coverage: {
    sessionsInspected: number;
    sessionsByHarness: Record<string, number>;
    observableInterventionsByHarness: Record<string, number>;
    instrumentationCaveat: string;
  };
  totals: {
    rawFeedbackRecords: number;
    logicalInterventions: number;
    duplicateRecords: number;
    sessionsWithInterventions: number;
    repeatedBeforeUser: number;
    deliveryContextMismatchCandidates: number;
  };
  gates: Record<string, number>;
  reactions: Record<string, number>;
  install: InstallAudit;
  interventions: Intervention[];
};

type Args = {
  since: string;
  jsonOut?: string;
  markdownOut?: string;
  sessionsFile?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { since: '7d' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') out.since = argv[++i] || '7d';
    else if (arg === '--json-out') out.jsonOut = argv[++i];
    else if (arg === '--markdown-out') out.markdownOut = argv[++i];
    else if (arg === '--sessions-file') out.sessionsFile = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun .agents/artifacts/2026-08-07/analyze-verify-work-complete.ts [options]

Options:
  --since <duration>       Rolling window, such as 7d or 48h (default: 7d)
  --json-out <path>        Write detailed, redacted evidence JSON
  --markdown-out <path>    Write the sanitized aggregate report
  --sessions-file <path>   Read session metadata from JSON instead of agents sessions`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function parseDuration(value: string): number {
  const match = /^(\d+)([mhdw])$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration '${value}'; use forms such as 30m, 48h, 7d, or 2w`);
  const amount = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return amount * unitMs;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const item = block as Record<string, unknown>;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string' && ['text', 'input_text', 'output_text'].includes(String(item.type))) {
        return item.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function syntheticUserMessage(text: string): boolean {
  return [
    /^\s*<\/?(?:bash-input|bash-stdout|bash-stderr)>/i,
    /^\s*<\/?(?:command-name|command-message|command-args|command-contents)>/i,
    /^\s*<\/?(?:local-command-stdout|local-command-stderr|local-command-caveat)>/i,
    /^\s*<\/?(?:system-reminder|task-notification|user-prompt-submit-hook)>/i,
    /^\s*<(?:permissions|collaboration_mode|environment_context)/i,
    /^\s*## (?:In-flight in this repo|Host & Fleet)/i,
    /^\s*Caveat: The messages below were generated by the user while running/i,
    /^\s*\[Request interrupted/i,
    /^\s*Base directory for this skill:/i,
    /^\s*[A-Za-z][A-Za-z-]* hook feedback:/,
  ].some((pattern) => pattern.test(text));
}

function toolFromBlock(block: Record<string, unknown>): { tool: string; command: string } | null {
  const type = String(block.type || '');
  if (!['tool_use', 'function_call', 'custom_tool_call'].includes(type)) return null;
  const tool = String(block.name || block.tool || 'tool');
  const input = block.input ?? block.arguments ?? block.args ?? {};
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { parsed = input; }
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const command = String(record.command ?? record.cmd ?? record.input ?? (typeof parsed === 'string' ? parsed : ''));
  return { tool, command };
}

export function normalizeTranscript(rawText: string, agent: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let index = 0;
  for (const rawLine of rawText.split('\n')) {
    if (!rawLine.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(rawLine); } catch { continue; }
    const timestamp = String(record.timestamp || '');

    if (agent === 'codex' && record.type === 'response_item' && record.payload && typeof record.payload === 'object') {
      const payload = record.payload as Record<string, unknown>;
      if (payload.type === 'message') {
        const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' || payload.role === 'developer' ? 'user' : undefined;
        const text = textFromContent(payload.content);
        if (role && text) events.push({ index: index++, timestamp, kind: 'message', role, text, synthetic: role === 'user' && syntheticUserMessage(text) });
      }
      const tool = toolFromBlock(payload);
      if (tool) events.push({ index: index++, timestamp, kind: 'tool', tool: tool.tool, command: tool.command });
      continue;
    }

    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : record;
    const roleValue = record.role ?? message.role;
    const role = roleValue === 'assistant' ? 'assistant' : roleValue === 'user' ? 'user' : undefined;
    const content = message.content ?? record.content;
    const text = textFromContent(content);
    if (role && text) {
      events.push({ index: index++, timestamp, kind: 'message', role, text, synthetic: role === 'user' && syntheticUserMessage(text) });
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const tool = toolFromBlock(block as Record<string, unknown>);
        if (tool) events.push({ index: index++, timestamp, kind: 'tool', tool: tool.tool, command: tool.command });
      }
    }
  }
  return events;
}

export function isGenuineFeedback(event: TimelineEvent): boolean {
  if (event.kind !== 'message' || !event.text) return false;
  const text = event.text.trim();
  return text.startsWith(FEEDBACK_PREFIX)
    && text.includes(HOOK_BASENAME)
    && /\]:\s*STOP GATE(?:\s*\([^)]+\))?:/s.test(text);
}

export function gateType(text: string): GateType {
  const named = /STOP GATE\s*\(([^)]+)\)/.exec(text)?.[1]?.toLowerCase();
  if (named === 'delivery') return 'delivery';
  if (named === 'keep moving') return 'keep-moving';
  if (/pull request\(s\).*still OPEN/is.test(text)) return 'open-pr';
  if (/command|script.*user|RUN IT YOURSELF/is.test(text)) return 'handback';
  if (/swarm|composed cross-track/is.test(text)) return 'swarm';
  if (/self-audit|original request|conversation goals|claimed this work is done, but you must verify/is.test(text)) return 'self-audit';
  return 'other';
}

function normalizedFeedback(text: string): string {
  return text
    .replace(/\[[^\]]*00-agent-verify-work-complete\.sh\]/, `[${HOOK_BASENAME}]`)
    .replace(/NOTE\s+[—-].*?(?=STOP GATE)/s, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function redact(text: string, max = 1_200): string {
  return text
    .replaceAll(homedir(), '~')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/([?&](?:token|key|secret|code)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .slice(0, max)
    .trim();
}

function classifyReaction(text: string, tools: Array<{ tool: string; command: string }>): Reaction {
  const lower = text.toLowerCase();
  const pushback = /\b(?:already (?:done|completed|captured|provided)|doesn'?t apply|does not apply|misfir|false trigger|not a delivery|diagnostic (?:answer|investigation)|research question|nothing to (?:close|commit)|no (?:repo|pr|code|files?|release)|no loop to close|gate is for|hook is pattern-matching|hook is flagging|stop gate is flagging)\b/.test(lower);
  const evidence = /https?:\/\/|\bscreenshot\b|\b(?:evidence|proof|metric|tests? (?:pass|passed|green)|verified|tool output|returned)\b|\b\d[\d,]*(?:\.\d+)?\s*(?:tests?|checks?|companies|items|%|ms|seconds?|minutes?)\b/.test(lower);
  const handoff = /\b(?:blocked on|handed off|handoff|watcher|background watch|owns (?:this|the)|needs your (?:touch ?id|login|decision))\b/.test(lower);
  if (pushback && evidence) return 'substantiated-pushback';
  if (pushback) return 'unsupported-pushback';
  if (tools.length > 0) return 'productive-action';
  if (handoff) return 'blocker-or-handoff';
  if (/\b(?:i(?:'ll| will)|let me|checking|running|fixing|updating|closing|merging)\b/.test(lower)) return 'verbal-compliance';
  if (!text.trim()) return 'no-assistant-reaction';
  return 'other';
}

function hasDeliveryActivity(events: TimelineEvent[]): boolean {
  return events.some((event) => {
    if (event.kind !== 'tool') return false;
    const text = `${event.tool || ''} ${event.command || ''}`;
    return /\bgh\s+pr\s+(?:create|merge|ready|rebase|close|reopen|edit)\b|\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|merge)\b|\b(?:apply_patch|Write|Edit)\b/.test(text);
  });
}

export function analyzeSession(meta: SessionMeta, events: TimelineEvent[], startMs: number, endMs: number): { raw: number; interventions: Intervention[] } {
  const feedback = events.filter((event) => isGenuineFeedback(event) && timestampMs(event.timestamp) >= startMs && timestampMs(event.timestamp) <= endMs);
  const logical: Array<{ event: TimelineEvent; duplicates: number }> = [];
  for (const event of feedback) {
    const prior = logical.at(-1);
    if (prior
      && gateType(prior.event.text || '') === gateType(event.text || '')
      && normalizedFeedback(prior.event.text || '') === normalizedFeedback(event.text || '')
      && timestampMs(event.timestamp) - timestampMs(prior.event.timestamp) <= DEDUPE_MS) {
      prior.duplicates += 1;
      continue;
    }
    logical.push({ event, duplicates: 0 });
  }

  const attemptsByChain = new Map<string, number>();
  const interventions = logical.map(({ event, duplicates }) => {
    const eventPos = events.indexOf(event);
    let userBoundaryBefore = -1;
    for (let i = eventPos - 1; i >= 0; i -= 1) {
      const candidate = events[i];
      if (candidate.kind === 'message' && candidate.role === 'user' && !candidate.synthetic) {
        userBoundaryBefore = i;
        break;
      }
    }
    let userBoundaryAfter = events.length;
    for (let i = eventPos + 1; i < events.length; i += 1) {
      const candidate = events[i];
      if (candidate.kind === 'message' && candidate.role === 'user' && !candidate.synthetic) {
        userBoundaryAfter = i;
        break;
      }
    }
    const priorAssistant = events.slice(userBoundaryBefore + 1, eventPos).reverse()
      .find((candidate) => candidate.kind === 'message' && candidate.role === 'assistant')?.text || '';
    const nextAssistant = events.slice(eventPos + 1, userBoundaryAfter)
      .find((candidate) => candidate.kind === 'message' && candidate.role === 'assistant')?.text || '';
    const toolEvents = events.slice(eventPos + 1, userBoundaryAfter)
      .filter((candidate) => candidate.kind === 'tool')
      .map((candidate) => ({ tool: candidate.tool || 'tool', command: redact(candidate.command || '', 500) }));
    const currentGate = gateType(event.text || '');
    const laterSameGate = logical.some(({ event: later }) => events.indexOf(later) > eventPos
      && events.indexOf(later) < userBoundaryAfter
      && gateType(later.text || '') === currentGate);
    const chainKey = `${userBoundaryBefore}:${currentGate}`;
    const attempt = (attemptsByChain.get(chainKey) || 0) + 1;
    attemptsByChain.set(chainKey, attempt);
    const beforeInTurn = events.slice(userBoundaryBefore + 1, eventPos);
    return {
      sessionKey: `${meta.agent}:${meta.id}`,
      sessionId: meta.shortId || meta.id.slice(0, 8),
      agent: meta.agent,
      version: meta.version || 'unknown',
      machine: meta.machine || 'unknown',
      project: meta.project || 'unknown',
      timestamp: event.timestamp,
      gate: currentGate,
      logicalAttempt: attempt,
      rawDuplicateCount: duplicates,
      reaction: classifyReaction(nextAssistant, toolEvents),
      repeatedBeforeUser: laterSameGate,
      productiveToolCount: toolEvents.length,
      deliveryContextMismatchCandidate: currentGate === 'delivery' && !hasDeliveryActivity(beforeInTurn),
      priorAssistant: redact(priorAssistant),
      feedback: redact(event.text || ''),
      nextAssistant: redact(nextAssistant),
      tools: toolEvents,
    } satisfies Intervention;
  });
  return { raw: feedback.length, interventions };
}

function runAgentsSessions(extra: string[]): SessionMeta[] {
  const result = spawnSync('agents', ['sessions', '--local', '--all', '--unmanaged', '--since', extra[0], '--limit', '100000', '--json', ...extra.slice(1)], {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`agents sessions failed: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error('agents sessions did not return a JSON array');
  return parsed as SessionMeta[];
}

function loadSessions(since: string, file?: string): SessionMeta[] {
  if (file) return JSON.parse(readFileSync(file, 'utf-8')) as SessionMeta[];
  const regular = runAgentsSessions([since]);
  const teams = runAgentsSessions([since, '--teams']);
  const byPath = new Map<string, SessionMeta>();
  for (const meta of [...regular, ...teams]) {
    if (meta.filePath) byPath.set(meta.filePath, meta);
  }
  return [...byPath.values()];
}

function sha256(path: string): string {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countString(value: unknown, needle: string): number {
  if (typeof value === 'string') return value.includes(needle) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countString(item, needle), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + countString(item, needle), 0);
  return 0;
}

function jsonRegistrationCount(path: string): number {
  if (!existsSync(path)) return 0;
  try { return countString(JSON.parse(readFileSync(path, 'utf-8')), HOOK_BASENAME); } catch { return 0; }
}

function managedHookCopies(harness: 'claude' | 'codex'): string[] {
  const root = join(homedir(), '.agents', '.history', 'versions', harness);
  if (!existsSync(root)) return [];
  const configDir = harness === 'claude' ? '.claude' : '.codex';
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'home', configDir, 'hooks', HOOK_BASENAME))
    .filter(existsSync);
}

export function auditInstallation(): InstallAudit {
  const systemRoot = join(homedir(), '.agents', '.system');
  const manifestPath = join(systemRoot, 'agents.yaml');
  const sourcePath = join(systemRoot, 'hooks', 'stop', HOOK_BASENAME);
  const sourceHash = sha256(sourcePath);
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '';
  const harnesses = (['claude', 'codex'] as const).map((harness) => {
    const configDir = harness === 'claude' ? '.claude' : '.codex';
    const activeCopy = join(homedir(), configDir, 'hooks', HOOK_BASENAME);
    const nativeConfig = join(homedir(), configDir, harness === 'claude' ? 'settings.json' : 'hooks.json');
    const copies = managedHookCopies(harness);
    return {
      harness,
      activeCopyPresent: existsSync(activeCopy),
      activeCopyMatchesSource: Boolean(sourceHash) && sha256(activeCopy) === sourceHash,
      activeRegistrations: jsonRegistrationCount(nativeConfig),
      managedCopies: copies.length,
      managedCopiesMatchingSource: copies.filter((copy) => sha256(copy) === sourceHash).length,
    };
  });
  return {
    systemRepo: 'gh:phnx-labs/.agents-system',
    manifestRegistered: /verify-work-complete:[\s\S]*?events:[\s\S]*?- Stop[\s\S]*?script:\s*stop\/00-agent-verify-work-complete\.sh/.test(manifest),
    sourcePresent: existsSync(sourcePath),
    sourceSha256: sourceHash,
    harnesses,
  };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] || 0) + 1;
}

export function buildAudit(sessions: SessionMeta[], since: string, now = new Date()): AuditResult {
  const duration = parseDuration(since);
  const endMs = now.getTime();
  const startMs = endMs - duration;
  const sessionsByHarness: Record<string, number> = {};
  const observableByHarness: Record<string, number> = {};
  const interventions: Intervention[] = [];
  let rawFeedbackRecords = 0;

  for (const meta of sessions) {
    increment(sessionsByHarness, meta.agent || 'unknown');
    if (!meta.filePath || !existsSync(meta.filePath)) continue;
    let rawText = '';
    try { rawText = readFileSync(meta.filePath, 'utf-8'); } catch { continue; }
    if (!rawText.includes(HOOK_BASENAME) || !rawText.includes('STOP GATE')) continue;
    const analyzed = analyzeSession(meta, normalizeTranscript(rawText, meta.agent), startMs, endMs);
    rawFeedbackRecords += analyzed.raw;
    interventions.push(...analyzed.interventions);
  }
  interventions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const intervention of interventions) increment(observableByHarness, intervention.agent);

  const gates: Record<string, number> = {};
  const reactions: Record<string, number> = {};
  for (const intervention of interventions) {
    increment(gates, intervention.gate);
    increment(reactions, intervention.reaction);
  }
  return {
    generatedAt: now.toISOString(),
    window: { since, start: new Date(startMs).toISOString(), end: now.toISOString() },
    coverage: {
      sessionsInspected: sessions.length,
      sessionsByHarness,
      observableInterventionsByHarness: observableByHarness,
      instrumentationCaveat: 'Claude persists blocking Stop-hook feedback in transcripts. Codex and most other harnesses currently do not persist equivalent hook-firing records, so zero observable interventions is not evidence that the hook never ran.',
    },
    totals: {
      rawFeedbackRecords,
      logicalInterventions: interventions.length,
      duplicateRecords: rawFeedbackRecords - interventions.length,
      sessionsWithInterventions: new Set(interventions.map((item) => item.sessionKey)).size,
      repeatedBeforeUser: interventions.filter((item) => item.repeatedBeforeUser).length,
      deliveryContextMismatchCandidates: interventions.filter((item) => item.deliveryContextMismatchCandidate).length,
    },
    gates,
    reactions,
    install: auditInstallation(),
    interventions,
  };
}

function pct(numerator: number, denominator: number): string {
  return denominator ? `${(100 * numerator / denominator).toFixed(1)}%` : 'n/a';
}

function rows(record: Record<string, number>): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join('\n');
}

export function renderMarkdown(audit: AuditResult, privateEvidencePath: string): string {
  const total = audit.totals.logicalInterventions;
  const acted = audit.interventions.filter((item) => item.productiveToolCount > 0).length;
  const pushback = (audit.reactions['substantiated-pushback'] || 0) + (audit.reactions['unsupported-pushback'] || 0);
  const installs = audit.install.harnesses
    .map((item) => `| ${item.harness} | ${item.activeCopyPresent ? 'present' : 'missing'} | ${item.activeRegistrations} | ${item.managedCopiesMatchingSource}/${item.managedCopies} |`)
    .join('\n');
  const coverage = Object.keys(audit.coverage.sessionsByHarness)
    .sort()
    .map((agent) => `| ${agent} | ${audit.coverage.sessionsByHarness[agent]} | ${audit.coverage.observableInterventionsByHarness[agent] || 0} |`)
    .join('\n');
  const mismatch = audit.totals.deliveryContextMismatchCandidates;
  return `---
kind: report
title: verify-work-complete — seven-day effectiveness audit
summary: A transcript-grounded audit of observable blocking interventions, agent reactions, context mismatches, and installation state.
status: complete
tracking: RUSH-2113
facts:
  - ${total} logical interventions after deduplication
  - ${mismatch} delivery-context mismatch candidates
  - ${audit.totals.duplicateRecords} duplicate feedback records
---

# The completion hook acts often, but cannot reliably tell a delivery from browser work

From ${audit.window.start.slice(0, 10)} through ${audit.window.end.slice(0, 10)}, the audit found **${total} logical blocking interventions** across **${audit.totals.sessionsWithInterventions} sessions**. Agents ran a tool after ${acted} interventions (${pct(acted, total)}); they pushed back without first running another tool after ${pushback} (${pct(pushback, total)}).

<div class="artifact-callout"><strong>Primary finding.</strong> ${mismatch} delivery-gate interventions had no PR, commit, push, merge, edit, or patch activity in the active user-turn chain. These are context-mismatch candidates, including browser-only work performed while the terminal happened to be inside a Git repository.</div>

<figure>
<svg viewBox="0 0 820 230" role="img" aria-labelledby="flow-title flow-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="flow-title">Observed stop-hook reaction flow</title>
  <desc id="flow-desc">A stop attempt reaches the hook, then either causes action, evidence-backed pushback, or repetition before the next user turn.</desc>
  <defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="currentColor"/></marker></defs>
  <g fill="none" stroke="currentColor" stroke-width="2" opacity=".55" marker-end="url(#arrow)">
    <path d="M190 112 H300"/><path d="M470 112 H565"/><path d="M470 112 C515 112 515 38 565 38"/><path d="M470 112 C515 112 515 188 565 188"/>
  </g>
  <g font-family="Inter,system-ui,sans-serif" text-anchor="middle">
    <rect x="24" y="76" width="166" height="72" rx="14" fill="#a3e635" opacity=".18" stroke="#a3e635"/>
    <text x="107" y="106" font-size="16" font-weight="700">Agent stops</text><text x="107" y="129" font-size="13">completion wording</text>
    <rect x="300" y="76" width="170" height="72" rx="14" fill="#f59e0b" opacity=".16" stroke="#f59e0b"/>
    <text x="385" y="106" font-size="16" font-weight="700">Hook blocks</text><text x="385" y="129" font-size="13">${total} logical events</text>
    <rect x="565" y="8" width="224" height="60" rx="14" fill="#22c55e" opacity=".15" stroke="#22c55e"/>
    <text x="677" y="34" font-size="15" font-weight="700">Acts with tools</text><text x="677" y="54" font-size="13">${acted}</text>
    <rect x="565" y="82" width="224" height="60" rx="14" fill="#60a5fa" opacity=".15" stroke="#60a5fa"/>
    <text x="677" y="108" font-size="15" font-weight="700">Pushes back</text><text x="677" y="128" font-size="13">${pushback}</text>
    <rect x="565" y="158" width="224" height="60" rx="14" fill="#ef4444" opacity=".14" stroke="#ef4444"/>
    <text x="677" y="184" font-size="15" font-weight="700">Repeats before user</text><text x="677" y="204" font-size="13">${audit.totals.repeatedBeforeUser}</text>
  </g>
</svg>
<figcaption>Observed response paths. Counts describe association after a gate, not proof that the gate caused the eventual action.</figcaption>
</figure>

## Scorecard

| Measure | Result |
|---|---:|
| Raw feedback records | ${audit.totals.rawFeedbackRecords} |
| Logical interventions | ${total} |
| Duplicate records removed | ${audit.totals.duplicateRecords} |
| Sessions with an intervention | ${audit.totals.sessionsWithInterventions} |
| Repeated before the next genuine user turn | ${audit.totals.repeatedBeforeUser} |
| Delivery-context mismatch candidates | ${mismatch} |

### Gate distribution

| Gate | Logical interventions |
|---|---:|
${rows(audit.gates)}

### Agent reaction

| Reaction | Logical interventions |
|---|---:|
${rows(audit.reactions)}

“Productive action” means at least one tool call followed the intervention before the next genuine user message. “Substantiated pushback” means the agent disputed the gate and cited a URL, screenshot, metric, test, or verification result. These categories measure the transcript, not whether every objection was ultimately correct.

## Context failures

The delivery chain is entered whenever the final message matches a generic completion phrase. It does not require a PR or Git delivery command. Once entered, the helper falls back to the terminal's current Git repository and classifies the original request with broad words such as “new,” “feature,” “API,” or “behavior.” A browser task can therefore become a supposed code delivery solely because the shell was opened inside a repository.

The supplied Lovable case demonstrates the full failure three times: the agent completed and later verified browser work, the hook demanded docs and CHANGELOG changes “in the PR,” and the agent correctly replied that no repository change or PR existed. Later blocks repeated even after the agent supplied a live screenshot, URL, and concrete imported-record counts.

## Harness coverage

| Harness | Sessions inspected | Observable blocking interventions |
|---|---:|---:|
${coverage}

<div class="artifact-callout"><strong>Coverage limit.</strong> ${audit.coverage.instrumentationCaveat}</div>

## Installation audit

The canonical source is **${audit.install.systemRepo}**. Manifest registration is **${audit.install.manifestRegistered ? 'present' : 'missing'}** and the central script is **${audit.install.sourcePresent ? 'present' : 'missing'}**.

| Harness | Active copy | Native registrations | Managed copies matching central source |
|---|---|---:|---:|
${installs}

This separates “installed” from “observable”: Codex has a native Stop registration, but its transcript format does not retain the feedback needed to reconstruct reactions.

## Recommendations

1. Require delivery evidence before running code-delivery checks: a responsible PR, repository mutation, or explicit ship/release request. Generic “done” wording alone is insufficient.
2. Keep outcome-evidence coaching separate from docs/CHANGELOG enforcement. Browser and external-app work can require screenshots or live verification without inventing a PR.
3. Emit structured hook telemetry with hook name, gate, goal key, attempt number, and result for every harness. Transcript prose should not be the only measurement source.
4. Treat repeated substantiated pushback as a classifier defect signal. Re-running the same instruction after the agent proves the gate is out of context adds cost without improving completion.

## Reproduce

\`\`\`bash
bun .agents/artifacts/2026-08-07/analyze-verify-work-complete.ts \\
  --since ${audit.window.since} \\
  --json-out ${privateEvidencePath} \\
  --markdown-out .agents/artifacts/2026-08-07/verify-work-complete-effectiveness-${audit.window.end.slice(0, 10)}.md
\`\`\`

The detailed JSON is local and redacted. It contains bounded context windows for review and must not be committed or published because session transcripts are confidential.
`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sessions = loadSessions(args.since, args.sessionsFile);
  const audit = buildAudit(sessions, args.since);
  if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(audit, null, 2)}\n`);
  if (args.markdownOut) writeFileSync(args.markdownOut, renderMarkdown(audit, args.jsonOut || '<private-evidence.json>'));
  console.log(JSON.stringify({
    window: audit.window,
    sessions: audit.coverage.sessionsInspected,
    rawFeedbackRecords: audit.totals.rawFeedbackRecords,
    logicalInterventions: audit.totals.logicalInterventions,
    duplicates: audit.totals.duplicateRecords,
    sessionsWithInterventions: audit.totals.sessionsWithInterventions,
    deliveryContextMismatchCandidates: audit.totals.deliveryContextMismatchCandidates,
    reactions: audit.reactions,
    gates: audit.gates,
    jsonOut: args.jsonOut,
    markdownOut: args.markdownOut,
  }, null, 2));
}

if (import.meta.main) main();
