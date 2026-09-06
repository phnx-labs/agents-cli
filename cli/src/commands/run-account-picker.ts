import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import { AGENTS, agentLabel } from '../lib/agents.js';
import { loginHint } from '../lib/signin-badge.js';
import {
  collectRunCandidates,
  foldRunAccountRows,
  isUsageVerified,
  latestReleaseOf,
  readinessFromCandidate,
  isSignInRecoverable,
  type AccountReadiness,
  type RotateCandidate,
  type RunAccountRow,
} from '../lib/accounting/rotate.js';
import { getGlobalDefault } from '../lib/installations/versions.js';
import { isAutoUpdateEnabledForAgent } from '../lib/installations/update-policy.js';
import { findUnifiedAccount, listNativeAccounts, nativeAccountHome, resolveAccountSelection } from '../lib/account-registry.js';
import { readMeta } from '../lib/state.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

const CANCEL_SELECTION = '__agents_cancel_account_selection__';

export interface RunAccountChoice {
  name: string;
  value: string;
  disabled?: string;
  /** Can serve a run right now: signed in, authenticated, and under quota. */
  ready: boolean;
  /**
   * Selectable, but picking it launches the harness so you can authenticate
   * first (RUSH-2334). Mutually exclusive with `ready`; never `disabled`.
   */
  signInRequired: boolean;
}

/** One named account row for `agents accounts switch` (reuses this picker's layout). */
export interface SwitchAccountRow {
  accountName: string;
  kind: 'provider' | 'native';
  detail: string;
  current: boolean;
  candidate: RotateCandidate | null;
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

/**
 * Why a row cannot be picked. Only a THROTTLE disables a row: the account is
 * signed in and out of capacity, so launching it just hammers an exhausted
 * account (RUSH-2132) and nothing the user does at this prompt helps.
 *
 * An AUTH exclusion (`signed_out` / `revoked`) is deliberately NOT disabled —
 * the harness's own TUI is the login surface, so picking that row and launching
 * is the only way to sign in through agents-cli. Disabling it left a fully
 * logged-out harness with no reachable account at all (RUSH-2334).
 */
function disabledReason(candidate: RotateCandidate, readiness: AccountReadiness): string | undefined {
  if (readiness.ready) return undefined;
  if (isSignInRecoverable(readiness)) return undefined;
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

/**
 * The row's state in the accounts audit's `authVerdict` vocabulary: `live` when
 * the account is signed in and its usage number is fresh enough to route on,
 * `unverified` when signed in but the number is stale or absent, then the
 * blocked states. Every non-live word is paired with what picking the row DOES
 * (`loginHint` for a sign-in, the exhausted window for a throttle).
 */
export function rowState(row: RunAccountRow): { state: string; fix: string | null } {
  if (row.signInOnly) return { state: 'logged out', fix: 'launch to sign in' };
  const r = row.readiness;
  if (r.ready) {
    return isUsageVerified(row.candidate)
      ? { state: 'live', fix: null }
      : { state: 'unverified', fix: null };
  }
  switch (r.reason) {
    case 'signed_out': return { state: 'logged out', fix: 'launch to sign in' };
    case 'revoked': return { state: 'reconnect needed', fix: 'launch to re-authenticate' };
    case 'out_of_credits': return { state: 'out of credits', fix: null };
    case 'rate_limited': return { state: 'rate-limited', fix: null };
  }
}

/**
 * Build aligned picker rows — one per ACCOUNT (`name · email`, plan, headroom,
 * state, tags) with usable accounts first and throttled rows disabled. No row
 * carries a version: the release is a harness property printed once above the
 * prompt by {@link printPickerHeader}; a row says `pinned <release>` only when
 * its home is held behind that release (PHNX-3940 S1/S2).
 */
export function buildRunAccountChoices(rows: RunAccountRow[]): RunAccountChoice[] {
  const rendered = rows.map((row) => {
    const readiness = row.readiness;
    const disabled = row.signInOnly ? undefined : disabledReason(row.candidate, readiness);
    const signInRequired = row.signInOnly || isSignInRecoverable(readiness);
    const { state, fix } = rowState(row);
    const tags = [
      row.deviation ? `pinned ${row.deviation.release}` : null,
      row.isDefault ? 'default' : null,
    ].filter((t): t is string => t !== null).join(' · ');
    return {
      row,
      display: row.display,
      plan: row.signInOnly ? '' : (row.plan ?? 'plan unavailable'),
      // An auth-blocked row shows what picking it DOES; its quota is moot until
      // there is a credential to spend it with.
      limits: fix ?? formatAccountLimits(row.candidate),
      state,
      tags,
      disabled,
      ready: !row.signInOnly && readiness.ready,
      signInRequired,
    };
  });

  const width = (key: 'display' | 'plan' | 'limits' | 'state') =>
    Math.max(0, ...rendered.map((r) => r[key].length));
  const displayW = width('display');
  const planW = width('plan');
  const limitsW = width('limits');
  const stateW = width('state');

  return rendered.map((r) => ({
    name: [
      r.display.padEnd(displayW),
      r.plan.padEnd(planW),
      r.limits.padEnd(limitsW),
      r.state.padEnd(stateW),
      r.tags,
    ].join('  ').trimEnd(),
    value: r.row.account,
    disabled: r.disabled,
    ready: r.ready,
    signInRequired: r.signInRequired,
  }));
}

/**
 * The harness line printed ONCE above the picker — `Claude Code 2.1.263 ·
 * automatic updates on` — and, when the picker appeared for a reason the user
 * did not ask for, that reason (S7). Pure; the caller writes it.
 */
export function pickerHeaderLines(
  agent: AgentId,
  latestRelease: string | null,
  autoUpdates: boolean,
  reason?: string,
): string[] {
  const lines: string[] = [];
  if (latestRelease) lines.push(`${AGENTS[agent].name} ${latestRelease} · automatic updates ${autoUpdates ? 'on' : 'off'}`);
  if (reason) lines.push(reason);
  return lines;
}

/**
 * The identity a bare `agents run <agent>` resolves to through its bindings and
 * per-harness default (audit finding 4): the `default` tag names what actually
 * launches, not the catalog's default flag. Null when nothing is bound, in
 * which case the global default HOME decides.
 */
function defaultIdentityFor(agent: AgentId, meta: ReturnType<typeof readMeta>, globalDefault: string | null): string | null {
  const target = `${agent}@${globalDefault ?? ''}`;
  const selection = resolveAccountSelection(undefined, agent, meta, { useDefault: true, target });
  if (!selection) return null;
  const account = findUnifiedAccount(selection.id, meta, undefined, agent);
  return account?.kind === 'native' ? account.identityKey : null;
}

/** Collect this box's candidates for `agent` and fold them into account rows (the picker's data path). */
export async function collectRunAccountRows(agent: AgentId): Promise<{ rows: RunAccountRow[]; latestRelease: string | null }> {
  const candidates = await collectRunCandidates(agent);
  const meta = readMeta();
  const globalDefault = getGlobalDefault(agent);
  const latestRelease = latestReleaseOf(candidates);
  const rows = foldRunAccountRows(candidates, {
    latestRelease: latestRelease ?? '',
    globalDefault,
    defaultIdentity: defaultIdentityFor(agent, meta, globalDefault),
    connectHomeFor: (accountId) => nativeAccountHome(accountId, meta),
    registered: listNativeAccounts(meta).filter((account) => account.agent === agent),
  });
  return { rows, latestRelease };
}

function switchRowStatus(row: SwitchAccountRow): { status: string; limits: string; ready: boolean } {
  if (!row.candidate) {
    return {
      status: row.kind === 'provider' ? 'credential' : 'named',
      limits: 'limits unavailable',
      ready: true,
    };
  }
  const readiness = readinessFromCandidate(row.candidate);
  const authReason = readiness.ready ? null : readiness.reason;
  const status = authReason === 'revoked'
    ? 'needs re-login'
    : authReason === 'signed_out'
      ? 'logged out'
      : authReason === 'rate_limited'
        ? 'rate limited'
        : authReason === 'out_of_credits'
          ? 'out of credits'
          : 'logged in';
  const limits = authReason === 'revoked'
    ? 'needs re-authentication'
    : authReason === 'signed_out'
      ? 'signed out'
      : formatAccountLimits(row.candidate);
  return { status, limits, ready: readiness.ready };
}

/**
 * Aligned picker rows for `accounts switch`. Same columns as the run picker
 * (identity, status, limits) but the value is the named account to set-default.
 * Rows stay selectable: setting a default is not a launch.
 */
export function buildSwitchAccountChoices(rows: SwitchAccountRow[]): RunAccountChoice[] {
  const rendered = rows.map((row) => {
    const { status, limits, ready } = switchRowStatus(row);
    const account = row.current ? `${row.accountName} (default)` : row.accountName;
    const kind = row.kind === 'provider' ? `provider · ${row.detail}` : `native · ${row.detail}`;
    return { account, kind, status, limits, ready, value: row.accountName };
  });
  const accountWidth = Math.max(0, ...rendered.map((row) => row.account.length));
  const kindWidth = Math.max(0, ...rendered.map((row) => row.kind.length));
  const statusWidth = Math.max(0, ...rendered.map((row) => row.status.length));
  return rendered.map((row) => ({
    name: [
      row.account.padEnd(accountWidth),
      row.kind.padEnd(kindWidth),
      row.status.padEnd(statusWidth),
      row.limits,
    ].join('  '),
    value: row.value,
    ready: row.ready,
    signInRequired: false,
  }));
}

/**
 * Prompt for the named account that becomes this harness's default.
 * A cancelled picker writes nothing.
 */
export async function pickSwitchAccount(agent: AgentId, rows: SwitchAccountRow[]): Promise<string | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Selecting a ${agentLabel(agent)} account`, [
      `agents accounts switch ${agent} <account>`,
      `agents accounts set-default ${agent} <account>`,
    ]);
  }
  if (rows.length === 0) {
    throw new Error(`No named accounts for ${agent}. Add one with 'agents accounts add <name> --provider <p>' or 'agents accounts name ${agent}@<version> <name>'.`);
  }
  const choices = buildSwitchAccountChoices(rows).map(
    ({ ready: _ready, signInRequired: _signInRequired, ...choice }) => choice,
  );
  try {
    return await select({
      message: `Select the default ${agentLabel(agent)} account:`,
      choices,
      loop: false,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/**
 * Whether a zero-healthy run may recover by launching for a login, or must keep
 * failing loud. Three inputs, all of which have to hold:
 *
 * - `recoverable` — at least one excluded account is only auth-blocked. An
 *   all-throttled set is never launched (RUSH-2132): only a window reset clears it.
 * - `tty` — a login needs a human present; off a TTY nobody can complete one.
 * - `json` — `--json` marks a MACHINE consumer, which must never be handed a
 *   picker or dropped into a login TUI. This mirrors the canonical
 *   `Surface.interactive = tty && !json` in `commands/utils.ts`; a `--json` caller
 *   gets the parseable fail-loud error instead.
 */
export function signInLaunchDecision(
  input: { recoverable: number; tty: boolean; json: boolean },
): 'launch' | 'fail-loud' {
  const humanPresent = input.tty && !input.json;
  return input.recoverable > 0 && humanPresent ? 'launch' : 'fail-loud';
}

/**
 * How a `balanced`/`available` run reacts when every account's usage is stale and
 * none is verified (PHNX-2526). A human present at a real terminal gets the
 * account `picker` — they can choose knowing the numbers are stale — while every
 * unattended shape (`--headless`, `--json`, or no TTY) `fail-loud`s with
 * NO_VERIFIED_USAGE rather than silently guess on a stale snapshot. `headless`
 * joins the gate because a routine/machine dispatch can carry a TTY yet have no
 * human to answer a picker; the split mirrors `signInLaunchDecision`.
 */
export function noVerifiedUsageDecision(
  input: { tty: boolean; json: boolean; headless: boolean },
): 'picker' | 'fail-loud' {
  const humanPresent = input.tty && !input.json && !input.headless;
  return humanPresent ? 'picker' : 'fail-loud';
}

/**
 * Choose which installed version to launch so the user can authenticate, when a
 * strategy found zero healthy accounts but at least one is merely signed out
 * (RUSH-2334). Returns the version to launch, or null if the user cancelled.
 *
 * A single candidate does NOT prompt — a one-item picker is pure noise, and the
 * only thing to decide has one answer. Several candidates fall through to the
 * normal account picker, which shows every account with its state so the choice
 * is informed (throttled rows stay disabled there). A row picked there is a
 * sign-in row (its own home) or a named account that needs a re-login — both
 * launch their home directly; a live account is resolved by the caller.
 *
 * Callers MUST have already confirmed an interactive terminal: off a TTY there
 * is nobody to complete the login, and the run should fail loud instead.
 */
export async function pickSignInLaunchVersion(
  agent: AgentId,
  recoverable: RotateCandidate[],
  quiet = false,
): Promise<string | null> {
  if (recoverable.length === 0) return null;

  if (recoverable.length > 1) {
    const selected = await pickRunAccountCandidate(agent);
    return selected?.home ?? null;
  }

  const [only] = recoverable;
  if (!quiet) {
    const readiness = readinessFromCandidate(only);
    const why = !readiness.ready && readiness.reason === 'revoked'
      ? 'has no valid credential (the server rejected its token)'
      : 'has no signed-in account';
    const who = only.accountName ? `reconnect ${only.accountName}` : 'sign in to a new account';
    process.stderr.write(chalk.yellow(
      `${agentLabel(agent)} ${why} — launching ${AGENTS[agent].name} ${only.releaseVersion} · ${who}.\n`,
    ));
    process.stderr.write(chalk.gray(`Sign in with: ${loginHint(agent)}\n`));
  }
  return only.version;
}

/**
 * Prompt for one account. Rows are accounts (`name · email`), the release is
 * printed once above the prompt, and the returned row's `account` is the
 * selector the caller resolves through the same path `agents run
 * <agent>#<name>` takes (R1). A cancelled picker launches nothing.
 *
 * `reason` is why the picker appeared when the user did not ask for it — e.g.
 * balanced could not verify any account's usage (S7).
 */
export async function pickRunAccountCandidate(
  agent: AgentId,
  opts: { reason?: string } = {},
): Promise<RunAccountRow | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Selecting a ${agentLabel(agent)} account`, [
      `agents run ${agent}#<account>`,
      `agents view ${agent}`,
    ]);
  }

  const { rows, latestRelease } = await collectRunAccountRows(agent);
  if (rows.length === 0) {
    throw new Error(`No installed ${agentLabel(agent)} versions are available. Run: agents add ${agent}@latest`);
  }

  const choices = buildRunAccountChoices(rows);
  // "Selectable" is broader than "ready": an auth-blocked row is pickable so the
  // launch can carry you into the harness's login (RUSH-2334). Only offer the
  // bail-out row when literally nothing can be chosen — i.e. every account is
  // throttled, which no amount of signing in fixes.
  const hasSelectableAccount = choices.some((choice) => !choice.disabled);
  const needsSignIn = choices.some((choice) => choice.signInRequired);
  const promptChoices = choices.map(
    ({ ready: _ready, signInRequired: _signInRequired, ...choice }) => choice,
  );
  if (!hasSelectableAccount) {
    promptChoices.push({
      name: 'No usable accounts — cancel',
      value: CANCEL_SELECTION,
    });
  }

  for (const line of pickerHeaderLines(agent, latestRelease, isAutoUpdateEnabledForAgent(agent), opts.reason)) {
    process.stderr.write(chalk.gray(`${line}\n`));
  }

  try {
    const account = await select({
      message: needsSignIn
        ? `Select a ${agentLabel(agent)} account for this run (pick a logged-out one to sign in):`
        : `Select a ${agentLabel(agent)} account for this run:`,
      choices: promptChoices,
      loop: false,
      // Every account on one screen: a fleet box holds more than inquirer's
      // seven-row default, and a hidden row is an account the user cannot see.
      pageSize: Math.max(7, promptChoices.length),
    });
    if (account === CANCEL_SELECTION) return null;
    return rows.find((row) => row.account === account) ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}
