import { select } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { agentLabel } from '../lib/agents.js';
import {
  collectRunCandidates,
  readinessFromCandidate,
  type RotateCandidate,
} from '../lib/rotate.js';
import { compareVersions, getGlobalDefault } from '../lib/versions.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

const CANCEL_SELECTION = '__agents_cancel_account_selection__';

export interface RunAccountChoice {
  name: string;
  value: string;
  disabled?: string;
  ready: boolean;
}

const WINDOW_ORDER = ['session', 'week', 'sonnet_week', 'month'] as const;
const WINDOW_LABELS = {
  session: 'Session',
  week: 'Week',
  sonnet_week: 'Sonnet week',
  month: 'Month',
} as const;

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Human-readable remaining capacity for every window the provider exposes. */
export function formatAccountLimits(candidate: RotateCandidate): string {
  const windows = candidate.usageSnapshot?.windows;
  if (!windows || windows.length === 0) return 'limits unavailable';

  return [...windows]
    .sort((a, b) => WINDOW_ORDER.indexOf(a.key) - WINDOW_ORDER.indexOf(b.key))
    .map((window) => {
      const left = Math.max(0, 100 - window.usedPercent);
      return left === 0
        ? `${WINDOW_LABELS[window.key]} exhausted`
        : `${WINDOW_LABELS[window.key]} ${formatPercent(left)}% left`;
    })
    .join(' · ');
}

function disabledReason(candidate: RotateCandidate): string | undefined {
  const readiness = readinessFromCandidate(candidate);
  if (readiness.ready) return undefined;
  if (readiness.reason === 'signed_out') return 'logged out';
  if (readiness.reason === 'out_of_credits') return 'out of credits';

  const windows = candidate.usageSnapshot?.windows ?? [];
  const blocking = windows.filter((window) => window.key !== 'sonnet_week');
  const considered = blocking.length > 0 ? blocking : windows;
  const exhausted = considered
    .filter((window) => window.usedPercent >= 100)
    .map((window) => WINDOW_LABELS[window.key]);
  return exhausted.length > 0
    ? `${exhausted.join(' and ')} ${exhausted.length === 1 ? 'limit' : 'limits'} reached`
    : 'rate limit reached';
}

/** Build aligned picker rows with usable accounts first and unsafe rows disabled. */
export function buildRunAccountChoices(
  candidates: RotateCandidate[],
  globalDefault: string | null,
): RunAccountChoice[] {
  const rows = candidates.map((candidate) => {
    const disabled = disabledReason(candidate);
    const version = candidate.version === globalDefault
      ? `${candidate.version} (default)`
      : candidate.version;
    return {
      candidate,
      account: candidate.accountLabel || 'account unavailable',
      version,
      status: candidate.signedIn ? 'logged in' : 'logged out',
      plan: candidate.usageSnapshot?.plan ?? candidate.plan ?? 'plan unavailable',
      limits: formatAccountLimits(candidate),
      disabled,
      ready: disabled === undefined,
    };
  });

  rows.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    const aDefault = a.candidate.version === globalDefault;
    const bDefault = b.candidate.version === globalDefault;
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return compareVersions(b.candidate.version, a.candidate.version);
  });

  const accountWidth = Math.max(0, ...rows.map((row) => row.account.length));
  const versionWidth = Math.max(0, ...rows.map((row) => row.version.length));
  const statusWidth = Math.max(0, ...rows.map((row) => row.status.length));
  const planWidth = Math.max(0, ...rows.map((row) => row.plan.length));

  return rows.map((row) => ({
    name: [
      row.account.padEnd(accountWidth),
      row.version.padEnd(versionWidth),
      row.status.padEnd(statusWidth),
      row.plan.padEnd(planWidth),
      row.limits,
    ].join('  '),
    value: row.candidate.version,
    disabled: row.disabled,
    ready: row.ready,
  }));
}

/** Prompt for one safe installed account/version. A cancelled picker launches nothing. */
export async function pickRunAccountCandidate(agent: AgentId): Promise<RotateCandidate | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Selecting a ${agentLabel(agent)} account`, [
      `agents run ${agent}@<version>`,
      `agents view ${agent}`,
    ]);
  }

  const candidates = await collectRunCandidates(agent);
  if (candidates.length === 0) {
    throw new Error(`No installed ${agentLabel(agent)} versions are available. Run: agents add ${agent}@latest`);
  }

  const choices = buildRunAccountChoices(candidates, getGlobalDefault(agent));
  const hasReadyAccount = choices.some((choice) => choice.ready);
  const promptChoices = choices.map(({ ready: _ready, ...choice }) => choice);
  if (!hasReadyAccount) {
    promptChoices.push({
      name: 'No usable accounts — cancel',
      value: CANCEL_SELECTION,
    });
  }

  try {
    const version = await select({
      message: `Select a ${agentLabel(agent)} account for this run:`,
      choices: promptChoices,
      loop: false,
    });
    if (version === CANCEL_SELECTION) return null;
    return candidates.find((candidate) => candidate.version === version) ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}
