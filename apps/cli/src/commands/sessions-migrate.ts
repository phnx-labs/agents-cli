/**
 * `agents sessions migrate` (alias `detach`) — relocate a RUNNING agent session
 * from this machine onto another (a fleet worker, a registered device, or a warm
 * ephemeral crabbox box), then stop the source so the interactive machine
 * reclaims its compute (RUSH-1977).
 *
 * This is orchestration glue over primitives that already exist — it does not
 * reinvent transport, resume, or scoring:
 *   - resolve the source session from the current tmux pane via `getActiveSessions()`
 *     (`provenance.mux.pane` matched against $TMUX_PANE);
 *   - pick / verify the target with the pure scorer in
 *     `lib/session/migrate-targets.ts` + `readyProbe()` / `bootstrapAgentsCli()`;
 *   - wrap up a dirty working tree (mechanical WIP-PR by default, or delegate a
 *     wrap-up turn to the running agent with --agent-wrapup);
 *   - ship the transcript with the SAME bundle pipeline as
 *     `sessions export --stdout | sessions import -`, over `sshExec`;
 *   - resume on the target through the SAME `openSurfaces({ backend:'tmux', host })`
 *     path `sessions resume --host` uses;
 *   - only AFTER the target's prompt is confirmed live, kill the source tmux
 *     session (`killSession`). --keep skips the kill (copy, not move).
 *
 * INVARIANT: the source is never killed before the transcript + branch are
 * confirmed on the target.
 */
import * as os from 'os';
import * as fs from 'fs';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import type { Command } from 'commander';
import { spawnSync } from 'child_process';

import type { SessionMeta } from '../lib/session/types.js';
import type { ActiveSession } from '../lib/session/active.js';
import { getActiveSessions } from '../lib/session/active.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { buildResumeCommand } from './sessions.js';
import { openSurfaces } from '../lib/terminal/index.js';
import { injectTargetFromReplyRail } from '../lib/session/inject.js';
import { injectIntoTerminal } from '../lib/terminal/index.js';
import { killSession } from '../lib/tmux/session.js';

import { listAllHosts, resolveHost } from '../lib/hosts/registry.js';
import type { Host } from '../lib/hosts/types.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { readyProbe, bootstrapAgentsCli, viewHasAgent } from '../lib/hosts/ready.js';
import { sshExec, shellQuote } from '../lib/ssh-exec.js';
import { loadDevices } from '../lib/devices/registry.js';
import { readStatsCache } from '../lib/devices/stats-cache.js';
import type { DeviceStats } from '../lib/devices/health.js';
import {
  crabboxList,
  crabboxWarmup,
  crabboxWaitReady,
  crabboxSshArgv,
  type CrabboxBox,
} from '../lib/crabbox/cli.js';
import { reusableBoxes, boxAddress } from './lease.js';
import {
  pickBestTarget,
  rankTargets,
  enumerateTargets,
  type MigrateTarget,
  type MigrateContext,
} from '../lib/session/migrate-targets.js';
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';

/** Agents whose sessions cannot be faithfully --resume'd (buildResumeCommand → null). */
type MigrateMode = 'resume' | 'rehydrate';

interface MigrateOptions {
  auto?: boolean;
  host?: string;
  lease?: boolean;
  mode?: MigrateMode;
  keep?: boolean;
  agentWrapup?: boolean;
}

export function registerSessionsMigrateCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('migrate [session-id]')
    .alias('detach')
    .description('Relocate a running session onto another machine (fleet worker, device, or ephemeral box), then stop the source here.')
    .option('--auto', 'Pick the best target host automatically (idle fleet worker preferred)')
    .option('--host <name>', 'Explicit target: an enrolled host, a device, or a warm ephemeral box slug')
    .option('--lease', 'Provision a fresh ephemeral crabbox box as the target')
    .option('--mode <mode>', 'resume (faithful --resume) or rehydrate (fresh agent reads the transcript)', 'resume')
    .option('--keep', 'Copy, not move — do NOT stop the source after resuming on the target')
    .option('--agent-wrapup', 'Delegate the dirty-tree wrap-up to the running agent instead of a mechanical WIP-PR');

  setHelpSections(cmd, {
    examples: `
      # Move the session in THIS pane onto the least-busy fleet worker
      agents sessions migrate --auto

      # Move a specific session onto a named host
      agents sessions migrate a1b2c3d4 --host yosemite-s1

      # Spin up a fresh ephemeral box and move onto it
      agents sessions migrate --lease

      # Copy (don't stop the source), letting the agent wrap up its own dirty tree
      agents sessions migrate --host box-a --keep --agent-wrapup
    `,
    notes: `
      - Without a [session-id], migrate resolves the session running in THIS tmux pane ($TMUX_PANE).
      - The source is stopped only AFTER the target's prompt is confirmed live; --keep skips the stop.
      - Non-resumable agents (gemini, antigravity, openclaw, rush, hermes, grok, kimi, droid) cannot be
        faithfully --resume'd, so migrate uses --mode rehydrate for them and says so.
      - Transport reuses the same bundle pipeline as 'sessions export --stdout | sessions import -', over SSH.
      - Resume reuses the same host path as 'sessions resume --host' (tmux backend).
    `,
  });

  cmd.action(async (sessionId: string | undefined, options: MigrateOptions) => {
    await sessionsMigrateAction(sessionId, options);
  });
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * Resolve the session to migrate. With an explicit id, resolve it from the
 * on-disk index. Without one, match the current tmux pane ($TMUX_PANE) against a
 * live session's `provenance.mux.pane` and resolve that id to its SessionMeta.
 */
async function resolveSourceSession(
  sessionId: string | undefined,
): Promise<{ meta: SessionMeta; active?: ActiveSession }> {
  if (sessionId) {
    const all = await discoverSessions({ all: true, sortBy: 'timestamp', limit: 2000 });
    const matches = resolveSessionById(all, sessionId);
    if (matches.length === 0) fail(`No session matches "${sessionId}".`);
    if (matches.length > 1) {
      fail(`"${sessionId}" is ambiguous (${matches.length} matches). Pass a longer id fragment.`);
    }
    const active = (await getActiveSessions()).find((s) => s.sessionId === matches[0].id);
    return { meta: matches[0], active };
  }

  const pane = process.env.TMUX_PANE;
  if (!pane) {
    fail('Not inside a tmux pane — pass an explicit [session-id] to migrate a specific session.');
  }
  const actives = await getActiveSessions();
  const active = actives.find((s) => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane === pane);
  if (!active || !active.sessionId) {
    fail(`No running session resolves to this pane (${pane}). Pass an explicit [session-id].`);
  }
  const all = await discoverSessions({ all: true, sortBy: 'timestamp', limit: 2000 });
  const matches = resolveSessionById(all, active.sessionId);
  if (matches.length === 0) fail(`This pane's session (${active.sessionId}) is not in the index yet.`);
  return { meta: matches[0], active };
}

/** Live headroom for the scorer: prefer the disk stats-cache (fast, no ssh). */
function statsByName(): Map<string, DeviceStats> {
  const cache = readStatsCache();
  return new Map(Object.entries(cache));
}

/** Enumerate + rank targets, honoring --host / --auto / --lease. */
async function resolveTarget(
  options: MigrateOptions,
  source: SessionMeta,
): Promise<MigrateTarget> {
  const selfHostname = os.hostname();
  const ctx: MigrateContext = {
    selfHostname,
    sourceHostname: source.machine ?? selfHostname,
    sourceOs: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
  };

  if (options.lease) {
    return await provisionEphemeralTarget();
  }

  const hosts = await listAllHosts();
  await loadDevices(); // ensure device registry is warmed (listAllHosts folds it in)
  let warm: CrabboxBox[] = [];
  try {
    warm = reusableBoxes(crabboxList(), Math.floor(Date.now() / 1000));
  } catch {
    warm = []; // crabbox not configured — fleet-only targets
  }
  const stats = statsByName();

  if (options.host) {
    // Explicit target: a fleet host/device, or a warm box slug.
    const box = warm.find((b) => b.slug === options.host);
    if (box) {
      return { name: box.slug, kind: 'ephemeral', os: 'linux', headroom: 'unknown', box };
    }
    const host = await resolveHost(options.host);
    if (!host) fail(`No host, device, or warm box named "${options.host}".`);
    if (host.name.toLowerCase() === selfHostname.toLowerCase()) {
      fail(`"${options.host}" is this machine — migrate needs a different target.`);
    }
    return { name: host.name, kind: 'fleet', os: host.os, headroom: 'unknown', host };
  }

  if (options.auto) {
    const best = pickBestTarget(hosts, warm, stats, ctx);
    if (!best) {
      fail('No eligible target found (no reachable, dispatchable host that isn\'t this machine or the source). Try --lease to provision a fresh box.');
    }
    console.log(chalk.gray(`Auto-selected ${best.name} (${best.kind}, ${best.headroom}).`));
    return best;
  }

  // Interactive: rank the candidates and let the user pick.
  if (!isInteractiveTerminal()) {
    fail('Pass --auto, --host <name>, or --lease to choose a target (no interactive picker without a tty).');
  }
  const ranked = rankTargets(enumerateTargets(hosts, warm, stats, ctx), ctx);
  if (ranked.length === 0) {
    fail('No eligible target found. Try --lease to provision a fresh box.');
  }
  try {
    const picked = await itemPicker<MigrateTarget>({
      message: 'Migrate this session to which machine?',
      items: ranked,
      filter: () => ranked,
      labelFor: (t) => `${chalk.bold(t.name.padEnd(20))}${chalk.gray(`${t.kind} · ${t.headroom}${t.os ? ' · ' + t.os : ''}`)}`,
      shortIdFor: (t) => t.name,
      enterHint: 'migrate',
    });
    if (!picked) fail('Cancelled.');
    return picked.item;
  } catch (err) {
    if (isPromptCancelled(err)) fail('Cancelled.');
    throw err;
  }
}

/** Provision a fresh ephemeral crabbox box (tailnet) and wait for it to be ready. */
async function provisionEphemeralTarget(): Promise<MigrateTarget> {
  console.log(chalk.gray('Provisioning a fresh ephemeral box (crabbox)…'));
  const leased = await crabboxWarmup({ netMode: 'tailscale' });
  const ready = await crabboxWaitReady(leased.slug).catch(() => leased);
  console.log(chalk.green(`Leased box ${ready.slug}.`));
  return { name: ready.slug, kind: 'ephemeral', os: 'linux', headroom: 'idle', box: ready };
}

/** Resolve the SSH target string for a migrate target (host alias or box address). */
function sshTargetForTarget(target: MigrateTarget): string {
  if (target.kind === 'fleet' && target.host) return sshTargetFor(target.host);
  if (target.kind === 'ephemeral' && target.box) {
    const addr = boxAddress(target.box);
    if (!addr) fail(`Ephemeral box ${target.box.slug} has no reachable address.`);
    return addr!;
  }
  fail(`Cannot resolve an SSH target for ${target.name}.`);
}

/**
 * Harness-parity gate (pure, testable). `buildResumeCommand` returns null for the
 * non-resumable agents (gemini, antigravity, openclaw, rush, hermes, grok, kimi,
 * droid) — for those a faithful --resume is impossible, so a requested `resume`
 * transparently becomes `rehydrate`. A resumable agent honors the request.
 * Returns the effective mode plus whether it was downgraded, so the caller can
 * print the notice.
 */
export function effectiveMode(source: SessionMeta, requested: MigrateMode): { mode: MigrateMode; downgraded: boolean } {
  const resumable = buildResumeCommand(source) !== null;
  if (!resumable && requested === 'resume') return { mode: 'rehydrate', downgraded: true };
  return { mode: requested, downgraded: false };
}

/**
 * Verify the target can run the session's agent+version. Returns the effective
 * mode: a non-resumable agent (buildResumeCommand → null) forces rehydrate; a
 * missing agents-cli triggers a bootstrap; a missing agent (in rehydrate) is a
 * printed notice, not a failure.
 */
function ensureTargetReady(
  target: MigrateTarget,
  sshTarget: string,
  source: SessionMeta,
  requested: MigrateMode,
): MigrateMode {
  // buildResumeCommand gates faithful resume: null → only rehydrate is possible.
  const gated = effectiveMode(source, requested);
  let mode = gated.mode;
  if (gated.downgraded) {
    console.log(chalk.yellow(`  ${source.agent} sessions can't be faithfully resumed — using --mode rehydrate.`));
  }

  const remoteOs = target.host?.os;
  let probe = readyProbe(sshTarget, remoteOs);
  if (!probe.reachable) {
    fail(`Target ${target.name} is not reachable over SSH (${sshTarget}).`);
  }
  if (!probe.version) {
    console.log(chalk.gray(`  agents-cli not found on ${target.name} — bootstrapping…`));
    const boot = bootstrapAgentsCli(sshTarget, null, remoteOs);
    if (!boot.ok) fail(`Failed to bootstrap agents-cli on ${target.name}: ${boot.output.split('\n').pop()}`);
    probe = readyProbe(sshTarget, remoteOs);
  }

  if (!viewHasAgent(probe.view, source.agent)) {
    if (mode === 'resume') {
      console.log(chalk.yellow(`  ${source.agent} isn't installed on ${target.name} — falling back to --mode rehydrate.`));
      mode = 'rehydrate';
    } else {
      console.log(chalk.gray(`  Note: ${source.agent} isn't installed on ${target.name}; the rehydrated session will read the transcript with whatever agent runs there.`));
    }
  }
  return mode;
}

/**
 * Wrap up the working tree so no local edits are stranded when the source stops.
 * Dirty → commit to a fresh branch + push + open a draft (WIP) PR. Clean-but-ahead
 * → push. --agent-wrapup instead injects a wrap-up turn into the running agent.
 * Returns the branch name to check out on an ephemeral target (or undefined).
 */
async function wrapUpWorkingTree(
  source: SessionMeta,
  active: ActiveSession | undefined,
  options: MigrateOptions,
): Promise<string | undefined> {
  const cwd = source.cwd;
  if (!cwd || !fs.existsSync(cwd)) return undefined;
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return undefined;

  const status = await git.status();
  const dirty = status.files.length > 0;
  const ahead = status.ahead ?? 0;

  if (!dirty && ahead === 0) {
    return status.current || undefined;
  }

  if (options.agentWrapup) {
    await delegateWrapupToAgent(source, active);
    // The agent handles the commit/push; report its current branch for checkout.
    const after = await git.status();
    return after.current || undefined;
  }

  if (dirty) {
    const branch = status.current && status.current !== 'main' && status.current !== 'master'
      ? status.current
      : `migrate/${source.shortId}`;
    // Only create the branch when we're on the default branch (don't strand edits on main).
    if (status.current === 'main' || status.current === 'master') {
      console.log(chalk.gray(`  Working tree dirty on ${status.current} — committing to a new branch ${branch}.`));
      await git.checkoutLocalBranch(branch);
    } else {
      console.log(chalk.gray(`  Working tree dirty on ${branch} — committing before migrate.`));
    }
    await git.add('-A');
    await git.commit(`wip: migrate ${source.agent} session ${source.shortId}`);
    await git.push(['-u', 'origin', branch]).catch((e) => {
      console.log(chalk.yellow(`  push failed: ${(e as Error).message}`));
    });
    openWipPr(cwd, branch);
    return branch;
  }

  // Clean but ahead — push what's committed.
  console.log(chalk.gray(`  ${ahead} local commit(s) ahead — pushing before migrate.`));
  await git.push().catch((e) => console.log(chalk.yellow(`  push failed: ${(e as Error).message}`)));
  return status.current || undefined;
}

/** Open a draft (WIP) PR for the wrap-up branch. Best-effort; a failure is a notice. */
function openWipPr(cwd: string, branch: string): void {
  const r = spawnSync(
    'gh',
    ['pr', 'create', '--draft', '--fill', '--head', branch],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status === 0) {
    const url = (r.stdout || '').trim().split('\n').pop();
    console.log(chalk.green(`  WIP PR: ${url}`));
  } else {
    console.log(chalk.yellow(`  Could not open a WIP PR (${(r.stderr || '').trim().split('\n').pop() || 'gh error'}). Branch ${branch} is pushed.`));
  }
}

/** --agent-wrapup: inject a wrap-up turn into the running agent's tmux pane. */
async function delegateWrapupToAgent(source: SessionMeta, active: ActiveSession | undefined): Promise<void> {
  const rail = active?.provenance?.reply;
  if (!rail) {
    console.log(chalk.yellow('  --agent-wrapup: no addressable reply rail for the running agent; committing mechanically instead is not possible here — the tree stays as-is.'));
    return;
  }
  const target = injectTargetFromReplyRail(rail);
  if (!target) {
    console.log(chalk.yellow('  --agent-wrapup: reply rail is not injectable; tree stays as-is.'));
    return;
  }
  const text =
    'Before this session is migrated to another machine, commit the current working changes to a branch, push it, and open a draft WIP PR. Then reply "wrapped up".';
  const res = await injectIntoTerminal(target, text, { enter: true });
  if (res.ok) {
    console.log(chalk.gray('  Asked the running agent to wrap up its working tree (draft PR).'));
  } else {
    console.log(chalk.yellow(`  --agent-wrapup injection failed: ${res.error ?? 'unknown'}.`));
  }
}

/**
 * Ship the transcript to the target with the SAME bundle pipeline as
 * `sessions export --stdout | sessions import -`: export the one session's bundle
 * locally, pipe it into `agents sessions import -` on the target over SSH.
 */
function shipTranscript(sshTarget: string, source: SessionMeta, remoteOs?: string): void {
  const local = spawnSync(
    process.execPath,
    [process.argv[1], 'sessions', 'export', source.id, '--stdout'],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (local.status !== 0 || !local.stdout) {
    fail(`Failed to export the transcript locally: ${(local.stderr || '').trim().split('\n').pop() || 'export error'}`);
  }
  const importCmd =
    remoteOs && remoteOs.toLowerCase().includes('win')
      ? 'agents sessions import -'
      : `bash -lc ${shellQuote('agents sessions import -')}`;
  const res = sshExec(sshTarget, importCmd, { input: local.stdout, timeoutMs: 120000 });
  if (res.code !== 0) {
    fail(`Failed to import the transcript on ${sshTarget}: ${res.stderr.trim().split('\n').pop() || 'import error'}`);
  }
  console.log(chalk.green('  Transcript shipped to the target.'));
}

/** Git-clone + checkout the (WIP) branch on an ephemeral box so the cwd resolves. */
function prepareEphemeralCwd(sshTarget: string, source: SessionMeta, branch: string | undefined): string | undefined {
  const remote = spawnSync('git', ['-C', source.cwd || '.', 'remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  const url = (remote.stdout || '').trim();
  if (remote.status !== 0 || !url) {
    console.log(chalk.yellow('  Ephemeral target: the source cwd has no origin remote to clone; the resumed session will start in $HOME.'));
    return undefined;
  }
  const dir = `~/migrated/${source.shortId}`;
  const checkout = branch ? ` && git checkout ${shellQuote(branch)}` : '';
  const script = `mkdir -p ~/migrated && (test -d ${dir}/.git || git clone ${shellQuote(url)} ${dir})${' && cd ' + dir + checkout}`;
  const res = sshExec(sshTarget, `bash -lc ${shellQuote(script)}`, { timeoutMs: 300000 });
  if (res.code !== 0) {
    console.log(chalk.yellow(`  Clone on the box failed (${res.stderr.trim().split('\n').pop() || 'git error'}); the resumed session will start in $HOME.`));
    return undefined;
  }
  return dir;
}

/**
 * Resume the session on the target through the SAME host path as
 * `sessions resume --host` (tmux backend). Returns true when the resume launched.
 */
async function resumeOnTarget(
  sshTarget: string,
  source: SessionMeta,
  remoteCwd: string | undefined,
  mode: MigrateMode,
): Promise<boolean> {
  const command = mode === 'resume' ? buildResumeCommand(source) : rehydrateCommand(source);
  if (!command) {
    fail(`Cannot build a resume command for ${source.agent} (mode ${mode}).`);
  }
  const cwd = remoteCwd ?? source.cwd ?? '~';
  const results = await openSurfaces(
    [{ cwd, command: command! }],
    { backend: 'tmux', host: sshTarget, packing: 'tabs' },
  );
  const r = results[0];
  if (!r || !r.ok) {
    console.log(chalk.red(`  Resume on ${sshTarget} failed: ${r?.error ?? 'unknown'}`));
    return false;
  }
  console.log(chalk.green(`  Resumed on the target (${command!.join(' ')}).`));
  return true;
}

/**
 * Rehydrate command: launch a fresh agent that reads the transcript. For a
 * non-resumable agent there is no faithful --resume, so we start the agent with
 * a prompt pointing it at the imported transcript path.
 */
function rehydrateCommand(source: SessionMeta): string[] {
  const prompt = `You are resuming a prior session (id ${source.id}). Read its transcript at the imported path under ~/.agents/.history and continue where it left off.`;
  return [source.agent, prompt];
}

async function sessionsMigrateAction(sessionId: string | undefined, options: MigrateOptions): Promise<void> {
  if (options.mode && options.mode !== 'resume' && options.mode !== 'rehydrate') {
    fail(`--mode must be 'resume' or 'rehydrate' (got "${options.mode}").`);
  }

  // 1. Resolve the source session (current-pane unless an id is given).
  const { meta: source, active } = await resolveSourceSession(sessionId);
  console.log(chalk.bold(`Migrating ${source.agent} session ${source.shortId}`) + chalk.gray(` (${source.cwd ?? 'no cwd'})`));

  // 2. Resolve the target host.
  const target = await resolveTarget(options, source);
  const sshTarget = sshTargetForTarget(target);

  // 3. Verify the target can run the agent+version (bootstrap if missing); resolve the mode.
  const mode = ensureTargetReady(target, sshTarget, source, options.mode ?? 'resume');

  // 4. Wrap up the working dir (WIP PR by default, or delegate to the agent).
  const branch = await wrapUpWorkingTree(source, active, options);

  // 5. Transport the transcript to the target (portable export/import over SSH).
  shipTranscript(sshTarget, source, target.host?.os);

  // 6. For an ephemeral box, clone + checkout the branch so the cwd resolves.
  const remoteCwd =
    target.kind === 'ephemeral' ? prepareEphemeralCwd(sshTarget, source, branch) : source.cwd;

  // 7. Resume on the target.
  const resumed = await resumeOnTarget(sshTarget, source, remoteCwd, mode);
  if (!resumed) {
    fail('Resume on the target did not launch — the source is left running (nothing was stopped).');
  }

  // 8. INVARIANT: only now that the transcript + branch are confirmed on the
  //    target and the resume launched, stop the source. --keep skips this.
  if (options.keep) {
    console.log(chalk.gray('--keep: the source session is left running (copy, not move).'));
  } else {
    await stopSource(source, active);
  }

  console.log(chalk.green(`\nMigrated ${source.shortId} to ${target.name}${options.keep ? ' (copy)' : ''}.`));
}

/** Stop the source tmux session (kill its tmux session by name via its socket). */
async function stopSource(source: SessionMeta, active: ActiveSession | undefined): Promise<void> {
  const mux = active?.provenance?.mux;
  const pane = mux?.pane ?? process.env.TMUX_PANE;
  const socket = mux?.socket;
  if (!pane) {
    console.log(chalk.yellow('  Could not resolve the source tmux pane to stop it — leaving the source running.'));
    return;
  }
  const name = resolveSessionNameForPane(pane, socket);
  if (!name) {
    console.log(chalk.yellow(`  Could not resolve a tmux session name for pane ${pane} — leaving the source running.`));
    return;
  }
  const killed = await killSession(name, socket);
  if (killed) console.log(chalk.gray(`  Stopped the source tmux session (${name}).`));
  else console.log(chalk.yellow(`  Source tmux session ${name} was already gone.`));
}

/** Map a tmux pane id to its session name via the same tmux binary the engine uses. */
function resolveSessionNameForPane(pane: string, socket?: string): string | undefined {
  const args = socket ? ['-S', socket] : [];
  const r = spawnSync('tmux', [...args, 'display-message', '-pt', pane, '-p', '#{session_name}'], { encoding: 'utf-8' });
  if (r.status !== 0) return undefined;
  const name = (r.stdout || '').trim();
  return name || undefined;
}
