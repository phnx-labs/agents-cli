/**
 * `agents sessions focus [id]` — take me to a live session, however it's reachable.
 *
 * Same detection as `go`, but where `go` *refuses* an un-attachable session,
 * `focus` **opens a new tab and resumes it** — locally, or on the remote over SSH
 * (via the terminal launch engine's `openSurfaces`, `host` = the peer). So:
 *   - in tmux (local/remote)   -> attach the live pane (join it, no fork)
 *   - in Ghostty               -> focus its tab
 *   - headless / plain / etc.  -> new tab + `resume` (a copy if it's mid-run — the
 *                                  original keeps going; a clean continue if it's idle)
 *
 * NOTE: joining a live process without forking is only possible via tmux — that's
 * why `--tmux`-wrapped launches are worth it for sessions you'll want back live.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { gatherLiveTargets, pickLiveTarget, pickLiveTargets, jumpTo, probeAttachRail, refuseFallback, type AttachRailLiveness, type UnreachableFallback } from './go.js';
import { sessionProcessIsLocal, sessionProcessHost, shortIdFromName, type ActiveSession } from '../lib/session/active.js';
import { attachTmux, getDefaultSocketPath, hasSession, runTmux } from '../lib/tmux/index.js';
import { SESSION_AGENTS, isAgentTmuxAlias, type SessionMeta, type SessionAgentId } from '../lib/session/types.js';
import {
  buildSessionRecoveryCommand,
  filterSessionsByQuery,
  formatLiveStatusHeadline,
  formatPickerLabel,
  isRunningLiveSession,
  pickerColumnsFor,
  resumeSessionInPlace,
  resolveSessionMetadataValue,
  resolveSessionAgentName,
  requestedLiveStatuses,
  type LiveStatusFilter,
} from './sessions.js';
import { resolveBackend, CONFIRM_THRESHOLD } from './sessions-resume.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { discoverSessions, resolveIndexedSessionById } from '../lib/session/discover.js';
import { machineId } from '../lib/session/sync/config.js';
import { collectSessionCandidates, normalizeDeviceSeed } from './sessions-browser.js';
import { buildPreview } from './sessions-picker.js';
import { multiItemPicker } from '../lib/picker.js';
import { sessionRecoveryRunArgs } from '../lib/session/recovery.js';
import { shellQuote, assertValidSshTarget } from '../lib/ssh-exec.js';
import {
  openSurfaces,
  currentContext,
  availableBackends,
  detectCurrentBackend,
  type Backend,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';

/** Options for `sessions focus` — device/host scope + the `--active` live-state filters. */
export interface FocusOptions {
  local?: boolean;
  attachOnly?: boolean;
  host?: string[];
  device?: string[];
  active?: boolean;
  agent?: string;
  claude?: boolean;
  codex?: boolean;
  kimi?: boolean;
  antigravity?: boolean;
  grok?: boolean;
  opencode?: boolean;
  all?: boolean;
  teams?: boolean;
  inTeam?: string;
  routine?: boolean;
  project?: string;
  skill?: string;
  plugin?: string;
  since?: string;
  until?: string;
  limit?: string;
  bookmarks?: boolean;
  unmanaged?: boolean;
  sort?: string;
  working?: boolean;
  idle?: boolean;
  waiting?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
}

const INHERITED_FOCUS_OPTIONS: Array<keyof FocusOptions> = [
  'local', 'host', 'device', 'active', 'agent',
  'claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode',
  'all', 'teams', 'inTeam', 'routine', 'project', 'skill', 'plugin',
  'since', 'until', 'limit', 'bookmarks', 'unmanaged', 'sort',
  'working', 'idle', 'waiting', 'orphan', 'orphaned', 'crashed',
  'closed', 'abandoned', 'queued', 'unknown',
];

/** Commander gives overlapping `sessions` flags to the parent command, even
 * when they appear after `focus`. Fold only values explicitly provided there
 * into the child options; child defaults (limit/sort) otherwise stay intact. */
export function inheritFocusOptions(child: FocusOptions, parent?: Command): FocusOptions {
  if (!parent) return child;
  const merged = { ...child };
  for (const key of INHERITED_FOCUS_OPTIONS) {
    const source = parent.getOptionValueSource(String(key));
    if (source && source !== 'default') {
      (merged as Record<string, unknown>)[key] = parent.getOptionValue(String(key));
    }
  }
  return merged;
}

/** `--device` is an alias of `--host`; both are repeatable. Merge into one host list. */
export function mergeFocusHosts(opts: FocusOptions): string[] {
  return [...(opts.host ?? []), ...(opts.device ?? [])];
}

/** Picker header that reflects the active filter + device, e.g. "Focus orphaned sessions on yosemite-s0:". */
export function focusHeader(statuses: LiveStatusFilter[], hosts: string[]): string {
  const where = hosts.length ? ` on ${hosts.join(', ')}` : '';
  if (statuses.length === 0) return `Focus a live session${where}:`;
  const word = statuses.length === 1 ? statusWord(statuses[0]) : 'filtered';
  return `Focus ${word} sessions${where}:`;
}

/** The adjective shown in the header for a single live-state filter. */
function statusWord(status: LiveStatusFilter): string {
  return status === 'orphaned' ? 'orphaned' : status;
}

export function registerFocusCommand(program: Command): void {
  const cmd = program
    // Hidden, but deliberately NOT warned. `sessions resume <id>` dispatches by
    // spawning `agents sessions focus <id>` (buildSessionLifecycleArgs), so a
    // deprecation notice here would print on every ordinary resume. focus is now
    // the internal lifecycle dispatcher; `resume` is the surface. Do not add a
    // console.warn here without first removing that delegation.
    .command('focus', { hidden: true })
    .argument('[selector]', 'Session id/prefix, agent@version, or topic/path search')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .option('--attach-only', 'Attach only — never open a new tab / resume a copy (the old `go` behavior)')
    .option('-H, --host <target...>', 'Scope the picker to live sessions on these devices (host alias or user@host; repeatable)')
    .option('--device <target...>', 'Alias for --host (device alias from `agents devices`; repeatable)')
    .option('--active', 'Only sessions present in the live roster')
    .option('-a, --agent <agent>', 'Filter by harness and recorded version (for example claude@latest)')
    .option('--claude', 'Shorthand for --agent claude')
    .option('--codex', 'Shorthand for --agent codex')
    .option('--kimi', 'Shorthand for --agent kimi')
    .option('--antigravity', 'Shorthand for --agent antigravity')
    .option('--grok', 'Shorthand for --agent grok')
    .option('--opencode', 'Shorthand for --agent opencode')
    .option('--all', 'Include every directory and all time')
    .option('--teams', 'Include team-spawned sessions')
    .option('--in-team <name>', 'Only one team lineage')
    .option('--routine', 'Only routine-run sessions')
    .option('-p, --project <name>', 'Only a named project')
    .option('--skill <name>', 'Only sessions that invoked this skill')
    .option('--plugin <name>', 'Only sessions that used this plugin')
    .option('--since <time>', 'Only sessions newer than this (for example 7d)')
    .option('--until <time>', 'Only sessions older than this timestamp')
    .option('-n, --limit <n>', 'Maximum candidates to load', '500')
    .option('--bookmarks', 'Only bookmarked sessions')
    .option('--unmanaged', 'Also include native-home sessions outside managed versions')
    .option('--sort <field>', 'Order candidates by recent, cost, or duration', 'recent')
    .option('--working', 'Only live sessions currently doing work')
    .option('--idle', 'Only live sessions that have stopped between turns')
    .option('--waiting', 'Only live sessions waiting on your input')
    .option('--orphan', 'Only sessions whose process outlived its terminal client')
    .option('--orphaned', 'Alias for --orphan')
    .option('--crashed', 'Only sessions whose terminal disappeared with the process')
    .option('--closed', 'Only recently observed sessions whose process exited normally')
    .option('--abandoned', 'Only sessions with no transcript progress for the abandonment window')
    .option('--queued', 'Only queued sessions that have not started running')
    .option('--unknown', 'Only sessions whose live state cannot be determined')
    .description('Focus sessions by id, harness/version, topic, device, or live state; attach living panes and recover ended ones')
    .action(async (id: string | undefined, opts: FocusOptions, command: Command) => {
      await focusAction(id, inheritFocusOptions(opts, command.parent ?? undefined));
    });

  setHelpSections(cmd, {
    examples: `
      # Focus a session directly (attach a living pane, otherwise recover it)
      agents sessions focus a1b2c3d4

      # Multi-select live sessions; each opens as a tab in this terminal
      agents sessions focus

      # Scope the picker to one device's orphaned sessions
      agents sessions focus --orphan --device yosemite-s0

      # Resolve latest on yosemite-s0, then pick from that version's sessions
      agents sessions focus claude@latest --device yosemite-s0

      # Attach only — refuse if nothing is joinable (old sessions go)
      agents sessions focus a1b2c3d4 --attach-only

      # Pick from live sessions on this machine only
      agents sessions focus --local
    `,
    notes: `
      - space toggles a session, enter opens the selected set; a single check + enter opens just one.
      - With no selector/filter, the picker shows the live fleet. An id focuses directly; agent@version and text selectors always show the preview picker.
      - A living tmux pane is JOINED (a second client, no fork). Dead/missing panes recover on the origin device: exact healthy origin uses native resume; otherwise a healthy version of the same harness receives /continue <id>.
      - An id/identity selector resolves across the whole reachable fleet on its own — you do NOT need --device to focus a session that lives on another box (same as resume/preview). --device only narrows the browsable picker and the agent/version resolution.
      - --host/--device and the sessions-browser filters compose. latest/oldest resolve against each selected device's installed versions.
      Lifecycle siblings (not synonyms):
        focus              attach if alive, otherwise recover (default "take me there")
        focus --attach-only  attach only; never fork (replaces go)
        detach / attach    interactive ↔ headless presence
        resume             multi-select history → tabs
        run --resume       single scripted continue
    `,
  });
}

/**
 * Which fallback fires when a session has no attach rail. `--attach-only` (the old
 * `go`) refuses; the default opens a new tab and resumes a copy. Pure so it's testable
 * without touching `jumpTo`'s side effects.
 */
export function selectFallback(attachOnly: boolean | undefined): UnreachableFallback {
  return attachOnly ? refuseFallback : resumeInNewTab;
}

export async function focusAction(id: string | undefined, opts: FocusOptions): Promise<void> {
  const hosts = mergeFocusHosts(opts);
  const statuses = requestedLiveStatuses(opts);
  // A device scope needs the cross-host sweep; --local only wins when no host is named.
  const local = !!opts.local && hosts.length === 0;
  const fallback = selectFallback(opts.attachOnly);

  const agentSelector = focusAgentSelector(id, opts);
  let textSelector = id && !agentSelector ? id : undefined;
  const filtered = !!id || hasFocusFilters(opts, statuses);

  // Preserve the fast live multi-picker for an unqualified `focus`. Every
  // selector/filter path below uses the sessions browser's shared candidate
  // pipeline and rich preview.
  if (filtered) {
    if (!isInteractiveTerminal() && !looksLikeIdentitySelector(textSelector)) {
      console.error(chalk.red('focus selectors need an interactive terminal; pass a session id for direct focus.'));
      process.exitCode = 1;
      return;
    }
    const limit = Number.parseInt(opts.limit ?? '500', 10);
    const idLookup = looksLikeIdentitySelector(textSelector);
    const sort = focusSort(opts.sort);
    if (!sort) {
      console.error(chalk.red(`Invalid sort: ${opts.sort}. Use recent, cost, or duration.`));
      process.exitCode = 1;
      return;
    }

    // RUSH-2477: an id selector for a LOCAL indexed session resolves against the
    // WAL index alone — a plain read, no write-heavy discovery scan (none of
    // `tryClaimScan`/`releaseScan`'s `BEGIN IMMEDIATE` writer lock) and no
    // boot-time fleet SSH fan-out. This is the crash-restart storm path: dozens
    // of `sessions resume <id>` at once must not each take the writer lock or
    // dial the not-yet-up tailnet. A genuine miss, an ambiguous prefix, or a
    // peer-owned row falls through to the fleet resolver below unchanged — the
    // narrow win is the exact case the storm hits, with no behaviour change for
    // a session that lives on another box.
    if (idLookup && hosts.length === 0 && looksLikeIdSelector(textSelector)) {
      const self = machineId();
      const localMatch = dedupeSessionsByLogicalId(
        await resolveIndexedSessionById(textSelector),
        self,
      );
      if (localMatch.length === 1 && !sessionProcessHost(localMatch[0], self)) {
        // Local live index only (ps/tmux, no fleet sweep) so a still-live pane is
        // still joined instead of resumed as a copy; a crashed session has no live
        // row and recovers in place.
        const { activeById } = await gatherLiveTargets(true, { statuses: [] });
        await focusResolvedSession(localMatch[0], activeById, self, fallback, opts.attachOnly === true);
        return;
      }
    }

    const { sessions, liveById, self, unreachable } = await collectSessionCandidates({
      running: opts.active === true || statuses.length > 0,
      statuses,
      agent: agentSelector ?? focusOptionAgent(opts),
      teams: opts.teams === true,
      team: opts.inTeam,
      bookmarks: opts.bookmarks === true,
      projectScope: opts.all || hosts.length > 0 || !!opts.project || idLookup ? 'all' : 'repo',
      project: opts.project,
      window: opts.since ?? (opts.all || idLookup ? undefined : '30d'),
      until: opts.until,
      routine: opts.routine === true,
      skill: opts.skill,
      plugin: opts.plugin,
      limit: idLookup && limit === 500 ? 5000 : (Number.isFinite(limit) && limit > 0 ? limit : 500),
      unmanaged: opts.unmanaged === true,
      sort,
      device: hosts.length === 1 ? normalizeDeviceSeed(hosts[0]) : undefined,
    }, { local, hosts, includeLive: true });

    if (unreachable.length > 0) {
      console.error(chalk.yellow(`Unavailable devices: ${unreachable.join(', ')}`));
    }

    const idSelector = textSelector && looksLikeIdSelector(textSelector) ? textSelector.toLowerCase() : undefined;
    let exact = idSelector
      ? dedupeSessionsByLogicalId(
          sessions.filter((session) => session.id.toLowerCase().startsWith(idSelector)),
          self,
        )
      : [];
    // A tmux alias naming a LIVE local session attaches directly. This must run
    // before the metadata resolver: that resolver treats an unmatched alias as a
    // keyword query, so `ag-kimi-632c1fbc` came back as 13 unrelated text hits
    // while the pane was alive and attachable the whole time.
    if (exact.length === 0 && textSelector && !hosts.length && await attachLiveTmuxAlias(textSelector)) return;

    // Not live (or remote-scoped): an alias still carries the session's shortid,
    // so resolve by THAT rather than handing the whole `ag-<agent>-<shortid>`
    // string to the resolver — which treats an unmatched alias as a keyword
    // query and answered `"ag-claude-dead5678" matches 200 sessions` for a pane
    // whose process had simply exited. SES-41 requires an alias to resolve to one
    // canonical session id.
    if (textSelector && isAgentTmuxAlias(textSelector)) {
      const short = shortIdFromName(textSelector);
      if (short) {
        textSelector = short;
        exact = dedupeSessionsByLogicalId(
          sessions.filter((session) => session.id.toLowerCase().startsWith(short)),
          self,
        );
      }
    }

    if (exact.length === 0 && textSelector && looksLikeIdentitySelector(textSelector)) {
      const outcome = await resolveSessionMetadataValue(textSelector, { local, hosts });
      if (outcome.kind === 'partial') {
        // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
        // resolver already resolves an id found on the reachable fleet (SES-9a),
        // so reaching here means the session was not found on any device we COULD
        // reach — it may live on an unreachable peer, which we could not check.
        const offline = outcome.failedPeers;
        console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
        console.error(chalk.red(`No session matching "${textSelector}" on any reachable device (${offline.length} unreachable, not checked).`));
        console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === 'ambiguous') {
        console.error(chalk.red(`"${textSelector}" matches ${outcome.candidates.length} sessions. Pass a longer id or alias.`));
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === 'not-found') {
        console.error(chalk.red(`No session matching "${textSelector}".`));
        process.exitCode = 1;
        return;
      }
      // The fleet resolver is authoritative for an id/identity selector — the same
      // one `resume`/`preview` use, and it already fanned out across the reachable
      // fleet. Focus the session it found even when that session falls outside the
      // candidate-pool DISPLAY filters (project scope, time window, device): those
      // filters scope the browsable list, not an exact id lookup. Requiring the
      // resolved row to ALSO be in the filtered pool is what made focusing a
      // peer-owned (or older / other-project) session need `--device`. Prefer the
      // pool's row when it carries the already-gathered live status, else fall back
      // to the resolved metadata (focusResolvedSession hops to the owner from it).
      const filteredMatch = sessions.find((session) => session.id === outcome.session.id);
      exact = [focusTargetForResolved(filteredMatch, outcome.session)];
    }
    if (exact.length === 1) {
      await focusResolvedSession(exact[0], liveById, self, fallback, opts.attachOnly === true);
      return;
    }
    if (exact.length > 1) {
      console.error(chalk.red(`"${textSelector}" is ambiguous (${exact.length} sessions). Use more of the id.`));
      process.exitCode = 1;
      return;
    }

    if (!isInteractiveTerminal()) {
      console.error(chalk.red(`No session matching "${textSelector}" in the selected scope.`));
      process.exitCode = 1;
      return;
    }

    const chosen = await pickFocusCandidates(sessions, liveById, textSelector);
    if (chosen.length === 0) return;
    await openFocusTabs(
      chosen.map((meta) => liveById.get(meta.id) ?? activeFromMeta(meta)),
      self,
      { metas: chosen, attachOnly: opts.attachOnly === true },
    );
    return;
  }

  const { self, activeById } = await gatherLiveTargets(local, { hosts, statuses });

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('focus needs an interactive terminal, or pass a session id.'));
    process.exitCode = 1;
    return;
  }
  if (activeById.size === 0) {
    const scope = describeScope(statuses, hosts);
    console.log(chalk.gray(`No live sessions to focus${scope}. To resume a past one: agents sessions resume`));
    return;
  }

  const header = focusHeader(statuses, hosts);

  // --attach-only keeps the old `go` single-jump: pick one, attach it in place (or refuse).
  if (opts.attachOnly) {
    const target = await pickLiveTarget(activeById, self, header, 'focus');
    if (!target) return;
    await jumpTo(target, self, fallback);
    return;
  }

  // Default: multi-select → open each selected session as a tab in this terminal.
  const targets = await pickLiveTargets(activeById, self, header);
  if (targets.length === 0) return;
  await openFocusTabs(targets, self);
}

/** A retained pane is not attachable merely because tmux can still display it. */
export function isAttachableLiveSession(session: ActiveSession): boolean {
  return isRunningLiveSession(session);
}

const FOCUS_AGENT_SHORTHANDS = ['claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode'] as const;

function focusOptionAgent(opts: FocusOptions): string | undefined {
  if (opts.agent) return opts.agent;
  return FOCUS_AGENT_SHORTHANDS.find((agent) => opts[agent] === true);
}

function focusAgentSelector(selector: string | undefined, opts: FocusOptions): string | undefined {
  const candidate = selector ?? focusOptionAgent(opts);
  if (!candidate) return undefined;
  const [name, version] = candidate.split('@', 2);
  const agent = resolveSessionAgentName(name);
  if (!agent) return undefined;
  return version === undefined ? agent : `${agent}@${version}`;
}

function looksLikeIdSelector(selector: string | undefined): selector is string {
  return !!selector && /^[0-9a-f][0-9a-f-]{5,}$/i.test(selector);
}

function looksLikeIdentitySelector(selector: string | undefined): selector is string {
  return !!selector && (
    /^[0-9a-f][0-9a-f-]{5,}$/i.test(selector) ||
    isAgentTmuxAlias(selector)
  );
}

/**
 * Attach a live tmux session named exactly as the selector, without needing the
 * session index to know anything about it.
 *
 * SES-41 requires a `ag-<agent>-<8hex>` tmux alias to resolve, but the alias's
 * hex is the LAUNCH id, not the harness session id, and for a harness that
 * writes no `state/sessions/<pid>.json` record there is no mapping back to a
 * SessionMeta at all. Measured on yosemite-s0: `--resolve ag-kimi-632c1fbc`
 * fell through to a keyword search and returned 13 unrelated rows, while the
 * pane itself was alive (`%124`, `kimi-code`). The pane is the thing the user
 * asked for, and its NAME is sufficient to attach it — so an unattributable
 * session is still reachable instead of being a dead end that forces raw
 * `tmux -S … attach`.
 *
 * Returns false when this is not an alias, the server/session is absent, or
 * every pane is dead — the caller then continues to normal id resolution.
 * SES-39's "re-read `pane_dead` immediately before attach" is honoured here:
 * liveness is queried at attach time, not read from the roster.
 */
/**
 * Rank two rows that are the same logical session, best first.
 *
 * Prefer the row that can actually be acted on: a real transcript over a
 * phantom index entry (a purged copy indexes with an empty `filePath`), then
 * this machine's copy over a peer mirror — resuming is machine-bound, so the
 * local row is the one whose harness state exists here.
 */
function sessionRowRank(s: SessionMeta, self?: string): number {
  return (s.filePath ? 4 : 0) + (self && s.machine === self ? 2 : 0) + (s._remote ? 0 : 1);
}

/**
 * Collapse rows that are the SAME logical session.
 *
 * A transcript syncs across the fleet, so one session appears once per machine
 * holding a copy. SES-IF-2a: "Synced copies sharing the same full id MUST count
 * as one logical session." `fleetCandidatesByQuery` already groups this way, but
 * this path filtered raw rows instead — so `focus <full-uuid>` answered
 * "is ambiguous (2 sessions). Use more of the id." with no longer id to give.
 * Measured on zion: one of the two rows had no transcript at all
 * ("Session transcript not available (file no longer exists). Path: ").
 */
export function dedupeSessionsByLogicalId(rows: SessionMeta[], self?: string): SessionMeta[] {
  const byId = new Map<string, SessionMeta>();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    const held = byId.get(key);
    if (!held || sessionRowRank(row, self) > sessionRowRank(held, self)) byId.set(key, row);
  }
  return [...byId.values()];
}

export type TmuxAliasState = 'not-an-alias' | 'no-server' | 'absent' | 'dead' | 'live';

/** Shape of the tmux alias the CLI mints for an agent session: `ag-<agent>-<shortid>`.
 * Delegates to the one canonical matcher beside the name parsers in active.ts. */
export function looksLikeTmuxAlias(selector: string): boolean {
  return isAgentTmuxAlias(selector);
}

/**
 * Classify a selector against the live tmux server. Split from the attach so the
 * decision is testable against a real tmux server without replacing the caller's
 * shell (attaching is not something a test can undo).
 */
export async function resolveTmuxAliasState(selector: string, socket?: string): Promise<TmuxAliasState> {
  if (!looksLikeTmuxAlias(selector)) return 'not-an-alias';
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return 'no-server';
  if (!(await hasSession(selector, sock).catch(() => false))) return 'absent';

  const panes = await runTmux({
    socket: sock,
    args: ['list-panes', '-t', `=${selector}`, '-F', '#{pane_dead}'],
  }).catch(() => undefined);
  const states = (panes?.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  return states.some(d => d === '0') ? 'live' : 'dead';
}

async function attachLiveTmuxAlias(selector: string): Promise<boolean> {
  const socket = getDefaultSocketPath();
  if (await resolveTmuxAliasState(selector, socket) !== 'live') return false;

  if (!process.stdout.isTTY) {
    console.error(chalk.red(`"${selector}" is a live tmux session, but attaching needs a TTY.`));
    console.error(chalk.gray(`  Run it from a terminal, or: agents tmux attach ${selector}`));
    process.exitCode = 1;
    return true;
  }
  // Already inside a tmux client on this socket — which is the normal state for
  // an interactive agent session here — MOVE that client instead of nesting a
  // second one. jumpTo (go.ts) does the same; attaching from inside tmux
  // otherwise stacks clients rather than taking you to the session.
  if (process.env.TMUX) {
    await runTmux({ socket, args: ['switch-client', '-t', `=${selector}`], throwOnError: false }).catch(() => {});
    console.log(chalk.gray(`Switched this tmux client to ${selector}.`));
    return true;
  }
  console.log(chalk.gray(`Attaching ${selector} — Ctrl-b d to detach.`));
  const code = await attachTmux({ socket, args: ['attach-session', '-t', `=${selector}`] });
  process.exitCode = code;
  return true;
}

function hasFocusFilters(opts: FocusOptions, statuses: LiveStatusFilter[]): boolean {
  return statuses.length > 0 || !!(
    opts.active || opts.local || opts.host?.length || opts.device?.length || focusOptionAgent(opts) ||
    opts.all || opts.teams || opts.inTeam || opts.routine || opts.project || opts.skill || opts.plugin ||
    opts.since || opts.until || opts.bookmarks || opts.unmanaged || (opts.sort && opts.sort !== 'recent')
  );
}

function focusSort(value: string | undefined): 'timestamp' | 'cost' | 'duration' | null {
  if (!value || value === 'recent') return 'timestamp';
  return value === 'cost' || value === 'duration' ? value : null;
}

async function pickFocusCandidates(
  sessions: SessionMeta[],
  liveById: Map<string, ActiveSession>,
  initialSearch?: string,
): Promise<SessionMeta[]> {
  if (sessions.length === 0) {
    console.log(chalk.gray('No sessions match the focus filters.'));
    return [];
  }
  const cols = {
    ...pickerColumnsFor(sessions),
    gutter: 6,
    showStatus: liveById.size > 0,
    showHost: liveById.size > 0,
  };
  try {
    const chosen = await multiItemPicker<SessionMeta>({
      message: 'Focus sessions:',
      items: sessions,
      filter: (query) => query.trim() ? filterSessionsByQuery(sessions, query) : sessions,
      labelFor: (session, query) => formatPickerLabel(
        session,
        query,
        cols,
        undefined,
        liveById.get(session.id)?.host,
        false,
        liveById.get(session.id),
      ),
      keyFor: (session) => session.id,
      buildPreview: (session) => {
        const headline = formatLiveStatusHeadline(liveById.get(session.id));
        const preview = buildPreview(session);
        return headline ? `${headline}\n${preview}` : preview;
      },
      pageSize: 15,
      initialSearch,
      emptyMessage: 'No sessions match.',
      enterHint: 'focus',
    });
    return chosen ?? [];
  } catch (err) {
    if (isPromptCancelled(err)) return [];
    throw err;
  }
}

/**
 * The session to focus once an id/identity selector has resolved across the
 * fleet. Prefer the already-gathered candidate-pool row (it carries the live
 * status collected for the picker), but fall back to the resolver's own metadata
 * when the resolved session is not in the filtered pool — a peer-owned, older, or
 * other-project session that the display filters excluded. Returning the resolved
 * session there (instead of rejecting it) is what lets `focus <id>` reach a
 * peer-owned session without `--device`, matching `resume`/`preview`.
 */
export function focusTargetForResolved(
  poolMatch: SessionMeta | undefined,
  resolved: SessionMeta,
): SessionMeta {
  return poolMatch ?? resolved;
}

async function focusResolvedSession(
  meta: SessionMeta,
  liveById: Map<string, ActiveSession>,
  self: string,
  fallback: UnreachableFallback,
  attachOnly: boolean,
): Promise<void> {
  const active = liveById.get(meta.id);
  if (active && isAttachableLiveSession(active)) {
    await jumpTo(active, self, fallback);
    return;
  }
  if (attachOnly) {
    console.log(chalk.yellow(`${meta.shortId} has no living process or pane to attach.`));
    process.exitCode = 1;
    return;
  }
  const remote = sessionProcessHost(meta, self);
  if (remote) {
    console.log(chalk.gray(`Recovering ${meta.shortId} on ${remote}…`));
    const rc = await runOnPeer(sessionRecoveryRunArgs(meta), remote, { tty: true });
    if (rc === 'no-target') {
      console.error(chalk.red(`Cannot recover ${meta.shortId}: ${remote} is unreachable.`));
      process.exitCode = 1;
    }
    return;
  }
  await resumeSessionInPlace(meta);
}

/** Focus one row selected by the shared session browser through the same
 * attach/recover decision as `agents sessions focus <id>`. */
export async function focusSelectedSession(
  meta: SessionMeta,
  active: ActiveSession | undefined,
  self: string,
): Promise<void> {
  if (active && !active.sessionId) {
    if (isAttachableLiveSession(active)) {
      await jumpTo(active, self, resumeInNewTab);
      return;
    }
    console.log(chalk.yellow('This live session has no session id or living attach rail to focus.'));
    process.exitCode = 1;
    return;
  }
  const liveById = active ? new Map([[meta.id, active]]) : new Map<string, ActiveSession>();
  await focusResolvedSession(meta, liveById, self, resumeInNewTab, false);
}

function activeFromMeta(meta: SessionMeta): ActiveSession {
  return {
    context: 'headless',
    kind: meta.agent,
    sessionId: meta.id,
    cwd: meta.cwd,
    project: meta.project,
    topic: meta.topic,
    startedAtMs: Date.parse(meta.timestamp),
    status: 'closed',
    machine: meta.machine,
  };
}

/** Human scope suffix for the empty-pool message, e.g. " (orphaned on yosemite-s0)". */
function describeScope(statuses: LiveStatusFilter[], hosts: string[]): string {
  const parts: string[] = [];
  if (statuses.length) parts.push(statuses.map(statusWord).join('/'));
  if (hosts.length) parts.push(`on ${hosts.join(', ')}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

/**
 * How a single selected live session opens in its new tab.
 *  - `attach` — a live tmux pane joined in the tab (a second client, no fork),
 *    local (`sh -c`) or remote (`ssh -tt`). tmux is the only rail that can be
 *    *joined* without forking (see the file header).
 *  - `resume` — no attach rail, so resume a copy in the tab (the original keeps
 *    running); never a silent drop.
 *  - `skip` — not resumable AND no rail: reported, not dropped.
 */
export type FocusSurfacePlan =
  | { kind: 'attach'; command: string[]; note: string }
  | { kind: 'resume'; command: string[]; note: string }
  | { kind: 'skip'; note: string };

/**
 * Shell that resolves a tmux pane to its session and attaches it — the exact form
 * `jumpTo` uses, minus the pre-select-window nicety, so a batch tab joins the live
 * session (a second client) without forking. Reused for local and (wrapped in ssh)
 * remote panes.
 */
export function tmuxAttachScript(mux: { socket?: string; pane: string }): string {
  const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
  const p = shellQuote(mux.pane);
  return (
    `dead=$(tmux ${sock}display-message -pt ${p} -p '#{pane_dead}' 2>/dev/null) || { echo 'agents: tmux pane is missing'; exit 42; }; ` +
    `[ "$dead" = 0 ] || { echo 'agents: tmux pane is dead'; exit 42; }; ` +
    `sess=$(tmux ${sock}display-message -pt ${p} '#{session_name}' 2>/dev/null); ` +
    `exec tmux ${sock}attach-session -t "\${sess:-${p}}"`
  );
}

/**
 * Decide how one live session opens as a tab. Pure over the session + a
 * `resumeCommandFor` resolver (injected so the local version-pinned resume command
 * and the tests stay decoupled from `discoverSessions`).
 */
export function planFocusSurface(
  s: ActiveSession,
  self: string,
  resumeCommandFor: (s: ActiveSession) => string[] | null,
  rail: AttachRailLiveness = { state: 'alive' },
): FocusSurfacePlan {
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;
  const sid = shortId(s);

  // Join rail = tmux only (local or remote over SSH). A new tab attaching the live
  // tmux session is a second client: join, no fork.
  if (mux?.kind === 'tmux' && mux.pane && rail.state === 'alive') {
    const script = tmuxAttachScript({ socket: mux.socket, pane: mux.pane });
    if (remote) {
      assertValidSshTarget(remote);
      return {
        kind: 'attach',
        command: ['ssh', '-tt', remote, shellQuote(script)],
        note: `attach ${mux.pane} on ${remote}`,
      };
    }
    return { kind: 'attach', command: ['sh', '-c', shellQuote(script)], note: `attach ${mux.pane}` };
  }

  // No join rail → resume a copy (never a silent drop).
  if (remote) {
    // Recover ON the peer so health and installed versions are resolved where
    // the transcript actually originated.
    const command = resumeCommandFor(s);
    if (!command) return { kind: 'skip', note: `${sid} has no recovery command` };
    assertValidSshTarget(remote);
    return {
      kind: 'resume',
      command: ['ssh', '-tt', remote, shellQuote(command.map(shellQuote).join(' '))],
      note: `recover on ${remote} (no living tmux pane to join)`,
    };
  }
  const cmd = resumeCommandFor(s);
  if (!cmd) return { kind: 'skip', note: `${sid} — ${s.kind} sessions can't be resumed, and it has no live tmux to join` };
  return { kind: 'resume', command: cmd, note: 'resume a copy (no live tmux to join)' };
}

/** The engine seam — real `openSurfaces`, overridable in tests to assert the tab requests. */
export type OpenSurfacesFn = typeof openSurfaces;

/** Test seams for `openFocusTabs`: inject the engine boundary + force a backend. */
export interface OpenFocusTabsDeps {
  open?: OpenSurfacesFn;
  /** Skip `resolveBackend` (which needs a live terminal) when set — tests pass 'tmux'. */
  backend?: Backend | 'inplace';
  /** Rich rows selected by the shared browser pipeline (including remote history). */
  metas?: SessionMeta[];
  /** Liveness boundary; production probes tmux, tests exercise planning deterministically. */
  probe?: typeof probeAttachRail;
  /** Strict focus mode: open living attach rails only; never recover a copy. */
  attachOnly?: boolean;
}

/**
 * Open each selected live session as a tab: attach its live pane where one exists,
 * else resume a copy. Reuses `resume`'s backend resolution + flood guard.
 */
export async function openFocusTabs(
  targets: ActiveSession[],
  self: string,
  deps: OpenFocusTabsDeps = {},
): Promise<void> {
  const open = deps.open ?? openSurfaces;
  const probe = deps.probe ?? probeAttachRail;
  // Resolve rich indexed metas ONCE so local resume commands stay version-pinned.
  let byId = new Map<string, SessionMeta>((deps.metas ?? []).map((m) => [m.id, m]));
  if (!deps.metas) {
    try {
      const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
      byId = new Map(metas.map((m) => [m.id, m]));
    } catch { /* fall back to synthesized metas per session */ }
  }
  const metaFor = (s: ActiveSession): SessionMeta => byId.get(s.sessionId ?? '') ?? metaFromActive(s);
  const resumeCommandFor = (s: ActiveSession): string[] | null => {
    if (deps.attachOnly) return null;
    const remote = !sessionProcessIsLocal(s, self);
    return buildSessionRecoveryCommand(metaFor(s), remote);
  };

  const planned = await Promise.all(targets.map(async (s) => {
    const rail = await probe(s, self);
    return { s, plan: planFocusSurface(s, self, resumeCommandFor, rail) };
  }));

  // Skips are reported, never silently dropped.
  for (const p of planned) if (p.plan.kind === 'skip') console.log(chalk.yellow(`  skip ${p.plan.note}`));
  const openable = planned.filter((p): p is { s: ActiveSession; plan: Exclude<FocusSurfacePlan, { kind: 'skip' }> } => p.plan.kind !== 'skip');
  if (openable.length === 0) {
    console.log(chalk.gray('Nothing to open in the selection.'));
    return;
  }

  const backend = deps.backend ?? (await resolveBackend({}, currentContext(), openable.length));
  if (backend === 'cancel') return;

  // Guard against opening a flood of live agents at once.
  if (openable.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({ message: `Open ${openable.length} sessions at once?`, default: false }).catch(() => false);
    if (!proceed) return;
  }

  // No tab-capable terminal (off-macOS, not in tmux): fall back to the single
  // foreground jump for the first, and say the rest need a tab-capable terminal.
  if (backend === 'inplace') {
    if (openable.length > 1) {
      console.log(chalk.yellow(`This terminal can't open tabs — jumping to the first; open in Ghostty/iTerm/tmux to focus several at once.`));
    }
    await jumpTo(openable[0].s, self, selectFallback(deps.attachOnly));
    return;
  }

  console.log(chalk.gray(`Opening ${openable.length} session${openable.length === 1 ? '' : 's'} in ${backend} (tabs)…`));
  // Pass agent + sessionId so the vscodium-agent backend can stamp the tab
  // chip without sniffing the local process tree (remote attach has no agent
  // binary on this box — #2478).
  const results = await open(
    openable.map((p) => ({
      cwd: cwdFor(p.s, byId),
      command: p.plan.command,
      agent: p.s.kind || undefined,
      sessionId: p.s.sessionId || undefined,
    })),
    { backend, packing: 'tabs' },
  );
  let opened = 0;
  results.forEach((r, i) => {
    const p = openable[i];
    if (r.ok) {
      opened++;
      console.log(chalk.green(`  opened ${shortId(p.s)}`) + chalk.gray(` — tab — (${p.plan.note})`));
    } else {
      console.log(chalk.red(`  failed ${shortId(p.s)} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${openable.length} in ${backend}.`));
}

/** A real cwd for the tab: the session's indexed cwd if it still exists, else here. */
function cwdFor(s: ActiveSession, byId: Map<string, SessionMeta>): string {
  const cwd = byId.get(s.sessionId ?? '')?.cwd ?? s.cwd;
  return cwd && fs.existsSync(cwd) ? cwd : process.cwd();
}

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

/** Minimal SessionMeta for a live session, enough for `buildResumeCommand` + placement. */
export function metaFromActive(s: ActiveSession): SessionMeta {
  return {
    id: s.sessionId ?? '',
    shortId: shortId(s),
    agent: s.kind as SessionAgentId,
    timestamp: new Date(s.startedAtMs ?? Date.now()).toISOString(),
    filePath: '',
    cwd: s.cwd,
  };
}

/** Look up the rich indexed SessionMeta by id so `version` survives (version-pinned resume). */
async function richMetaById(id: string): Promise<SessionMeta | undefined> {
  try {
    const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
    return metas.find((m) => m.id === id) ?? metas.find((m) => m.id.startsWith(id));
  } catch {
    return undefined;
  }
}

/**
 * `focus`'s fallback for a session with no attach rail: reopen it and hand you to it.
 *   - remote → resume ON the peer over SSH (foreground) — the peer resolves the pinned
 *              version and holds the transcript, and `-tt` delivers you there.
 *   - local  → resume in a new tab in your terminal, version-pinned via the indexed meta.
 * Note: for a session that's still mid-run, this opens a COPY (the original keeps going);
 * only tmux can *join* a live one without forking (see the header).
 */
const resumeInNewTab: UnreachableFallback = async (s, remote) => {
  const id = s.sessionId ?? '';
  if (!id) {
    console.log(chalk.yellow('This session has no id to resume.'));
    return;
  }

  // Remote: the transcript + pinned version live on the peer, so resume THERE over SSH.
  // runOnPeer runs `agents sessions resume <id>` with a real TTY (`-tt`) in the foreground —
  // it actually delivers you to the session (the peer picks the right version + HOME).
  if (remote) {
    console.log(chalk.gray(`${shortId(s)} has no live terminal on ${remote} — resuming it there over SSH…`));
    const rc = await runOnPeer(sessionRecoveryRunArgs({ id }), remote, { tty: true });
    if (rc === 'no-target') {
      console.log(chalk.red(`${remote} isn't reachable as a device. Try: agents devices sync`));
      console.log(chalk.gray(`  recovery must run on ${remote}, where the indexed session originated`));
    }
    return;
  }

  // Local: resume in a new tab. Use the indexed meta so the version-pinned binary
  // resumes in the same isolated HOME the transcript was written in.
  const meta = (await richMetaById(id)) ?? metaFromActive(s);
  const command = buildSessionRecoveryCommand(meta);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();

  const ctx = currentContext();
  const backend: Backend | undefined = detectCurrentBackend(ctx) ?? availableBackends(ctx)[0]?.id;
  if (!backend) {
    // No tab-capable surface (off-macOS, not in tmux) — resume in this process.
    await resumeSessionInPlace(meta);
    return;
  }

  console.log(chalk.gray(`${shortId(s)} has no live terminal to attach — opening a new ${backend} tab and resuming a copy.`));
  const results = await openSurfaces([{ cwd, command }], { backend, packing: 'tabs' });
  const r = results[0];
  if (!r || !r.ok) {
    console.log(chalk.red(`  failed to open — ${r?.error ?? 'unknown error'}`));
    console.log(chalk.gray(`  try: agents sessions resume ${meta.shortId}`));
  }
};
