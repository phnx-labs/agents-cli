/**
 * Reconcile engine for `agents apply`. The diff (`diffFleet`) is pure and unit-
 * tested; execution (`probeDevice`, `reconcileDevice`, `runFleetApply`) drives
 * the real fleet over SSH and is verified end-to-end against live devices.
 *
 * Flow per device: probe → install/upgrade agents-cli → add missing agents →
 * sync config → propagate login. Every step reuses an existing primitive
 * (`readyProbe`, `bootstrapAgentsCli`, `buildRemoteAgentsInvocation`, `sshExec`).
 */

import * as os from 'os';
import type { DeviceProfile } from '../devices/registry.js';
import { sshTargetFor } from '../devices/connect.js';
import { readyProbe, bootstrapAgentsCli } from '../hosts/ready.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { sshExec } from '../ssh-exec.js';
import type { TeamsDoctorEntry } from '../teams/agents.js';
import {
  isPropagatableAgent,
  hasPortableAuthFiles,
  isCredentialSafeToPropagate,
  KEYCHAIN_BOUND_ON_MAC,
  buildAuthBundle,
} from './auth-sync.js';
import type {
  DeviceDesired,
  DeviceProbe,
  DeviceDiff,
  FleetAction,
  FleetPlan,
  AuthFilePayload,
} from './types.js';

/** Strip a version suffix from an agent spec: `claude@latest` -> `claude`. */
export function agentIdOf(spec: string): string {
  return spec.split('@')[0].trim();
}

/**
 * The explicit pinned version of a spec, or undefined for an id-level spec.
 * `claude@2.1.170` -> `2.1.170`; `claude`, `claude@latest`, `claude@oldest`, and
 * `claude@all` all return undefined (the label channels install-latest / are
 * expanded upstream, so they diff at id granularity, not per-version).
 */
export function pinnedVersion(spec: string): string | undefined {
  const at = spec.indexOf('@');
  if (at < 0) return undefined;
  const v = spec.slice(at + 1).trim();
  if (!v || v === 'latest' || v === 'oldest' || v === 'all') return undefined;
  return v;
}

/** True when any spec in the roster pins an explicit version (needs a version probe). */
export function rosterNeedsVersions(desired: DeviceDesired[]): boolean {
  return desired.some((d) => d.agents.some((s) => pinnedVersion(s) !== undefined));
}

/**
 * Expand any `<agent>@all` spec into one pinned spec per version installed on the
 * source, so `--agent claude@all` replicates THIS machine's exact version set.
 * `versionsOf` returns the source's installed versions for an agent id. Every
 * other spec passes through unchanged; the result is de-duplicated in order.
 * Throws if `@all` names an agent with no installed versions here (nothing to
 * replicate — a clear misconfig, not a silent no-op).
 */
export function expandAllSpecs(specs: string[], versionsOf: (id: string) => string[]): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    const at = spec.indexOf('@');
    const label = at >= 0 ? spec.slice(at + 1).trim() : '';
    if (label !== 'all') {
      out.push(spec);
      continue;
    }
    const id = agentIdOf(spec);
    const versions = versionsOf(id);
    if (versions.length === 0) {
      throw new Error(`--agent ${spec}: no ${id} versions installed on this machine to replicate.`);
    }
    for (const v of versions) out.push(`${id}@${v}`);
  }
  return [...new Set(out)];
}

/**
 * Parse `agents view --json` (the all-agents array form) into a map of agent id
 * -> installed version strings. Tolerant: returns undefined on any parse failure
 * so a version-pinned spec falls back to id-level presence rather than crashing.
 */
export function parseInstalledVersions(stdout: string): Record<string, string[]> | undefined {
  try {
    const arr = JSON.parse(stdout) as Array<{ agent?: unknown; versions?: unknown }>;
    if (!Array.isArray(arr)) return undefined;
    const out: Record<string, string[]> = {};
    for (const a of arr) {
      if (a && typeof a.agent === 'string' && Array.isArray(a.versions)) {
        out[a.agent] = (a.versions as Array<{ version?: unknown }>)
          .map((v) => v?.version)
          .filter((v): v is string => typeof v === 'string');
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Source-side auth availability, computed once from `snapshotAuth`. */
export interface SourceAuth {
  /** Agent ids the source has a readable, propagatable credential file for. */
  available: Set<string>;
  /** Agent ids whose source auth is device-bound (macOS keychain). */
  bound: Set<string>;
  /** The captured file payloads, keyed by agent. */
  filesByAgent: Map<string, AuthFilePayload[]>;
}

/**
 * Can we propagate `agent`'s login to a target on `targetPlatform`? False when
 * the agent has no portable file, the source can't provide it (bound / not
 * signed in), or the target consumes credentials from its own keychain.
 */
export function canPushLogin(agent: string, targetPlatform: string | undefined, src: SourceAuth): boolean {
  if (!isPropagatableAgent(agent)) return false;
  if (src.bound.has(agent)) return false;
  if (targetPlatform === 'macos' && KEYCHAIN_BOUND_ON_MAC.has(agent)) return false;
  return src.available.has(agent);
}

export interface DiffContext {
  /** agents-cli version the source is on — the fleet target version. */
  targetCliVersion: string;
  sourceAuth: SourceAuth;
  /** Secrets-bundle names the profile declares. Values are keychain-local and
   * can't be pushed, so each reachable device surfaces them as a manual recreate
   * (`needs-secret`) — informational, never an executed mutation. */
  secretsBundles?: string[];
}

/** Pure: desired vs probed -> per-device diff + flat action list. */
export function diffFleet(desired: DeviceDesired[], probes: Map<string, DeviceProbe>, ctx: DiffContext): FleetPlan {
  const devices: DeviceDiff[] = [];
  const actions: FleetAction[] = [];

  for (const d of desired) {
    const probe = probes.get(d.device) ?? {
      device: d.device,
      reachable: false,
      installedAgents: [],
      note: 'not probed',
    };
    const rowActions: FleetAction[] = [];
    const loginBlocked: string[] = [];
    const secretsNeeded: string[] = [];

    if (probe.reachable) {
      // agents-cli presence.
      if (!probe.cliVersion) {
        rowActions.push({ device: d.device, kind: 'install-cli', detail: `install agents-cli ${ctx.targetCliVersion}` });
      } else if (probe.cliVersion !== ctx.targetCliVersion) {
        rowActions.push({ device: d.device, kind: 'upgrade-cli', detail: `agents-cli ${probe.cliVersion} -> ${ctx.targetCliVersion}` });
      }
      // agents. A version-pinned spec (`claude@2.1.170`, or an expanded
      // `claude@all` member) is present only when that exact version is on the
      // device; a bare/latest spec diffs at id granularity. So `--agent claude@all`
      // installs every missing version even when some claude is already there.
      for (const spec of d.agents) {
        const id = agentIdOf(spec);
        const want = pinnedVersion(spec);
        const present = want !== undefined
          ? (probe.installedVersions?.[id]?.includes(want) ?? false)
          : probe.installedAgents.includes(id);
        if (!present) {
          rowActions.push({ device: d.device, kind: 'add-agent', agent: id, spec, detail: `install ${spec}` });
        }
      }
      // config.
      if (d.sync.length > 0) {
        rowActions.push({ device: d.device, kind: 'sync-config', detail: `sync config (${d.sync.join(', ')})` });
      }
      // login — per agent id, not per spec: `claude@all` names one id many times,
      // but login propagates once per agent (its credential is version-shared).
      if (d.login === 'sync') {
        for (const id of [...new Set(d.agents.map(agentIdOf))]) {
          if (canPushLogin(id, probe.platform, ctx.sourceAuth)) {
            rowActions.push({ device: d.device, kind: 'push-login', agent: id, detail: `propagate ${id} login` });
          } else if (hasPortableAuthFiles(id) && !isCredentialSafeToPropagate(id)) {
            // Single-use rotating refresh tokens (e.g. droid/WorkOS) must never be
            // copied across boxes — the first refresh invalidates every other copy.
            // Surface per-machine login guidance instead of silently propagating.
            loginBlocked.push(id);
            rowActions.push({ device: d.device, kind: 'needs-login', agent: id, detail: `${id} login uses a single-use rotating refresh token — log in on ${d.device} itself` });
          } else if (
            isPropagatableAgent(id) &&
            (ctx.sourceAuth.bound.has(id) || (probe.platform === 'macos' && KEYCHAIN_BOUND_ON_MAC.has(id)))
          ) {
            // A login-propagation candidate we still can't push: the source token
            // is keychain-bound (unextractable), or the macOS target consumes its
            // own keychain. Surface those as manual — don't fake. Agents that were
            // never propagation candidates (no portable file), or a source that
            // simply isn't signed in, are silently skipped the same on every OS.
            loginBlocked.push(id);
            rowActions.push({ device: d.device, kind: 'needs-login', agent: id, detail: `${id} needs a manual login` });
          }
        }
      }
      // secrets — surfaced, never pushed (values are keychain-local). Declared
      // once at the manifest level, so every reachable device gets the same
      // manual-recreate reminder. Not an executable action (see idempotence
      // check in commands/apply.ts, which excludes needs-* kinds).
      if (ctx.secretsBundles && ctx.secretsBundles.length > 0) {
        for (const bundle of ctx.secretsBundles) {
          secretsNeeded.push(bundle);
          rowActions.push({ device: d.device, kind: 'needs-secret', detail: `recreate secrets bundle '${bundle}' (\`agents secrets create ${bundle}\`)` });
        }
      }
    }

    devices.push({ device: d.device, desired: d, probe, actions: rowActions, loginBlocked, secretsNeeded });
    actions.push(...rowActions);
  }

  return { devices, actions };
}

// ---- execution (real SSH; verified end-to-end, not unit-mocked) ----

function osHint(platform: string | undefined): string | undefined {
  return platform === 'windows' ? 'windows' : undefined;
}

/** POSIX login shells often miss the shims dir; inject it (mirrors doctor). */
function remoteEnv(platform: string | undefined): Record<string, string> | undefined {
  return platform === 'windows' ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
}

export interface ProbeOptions {
  /** Also fetch per-agent installed versions (one extra `agents view --json`
   * round-trip). Enable only when the plan has a version-pinned spec. */
  withVersions?: boolean;
}

/** Probe one device: reachability + agents-cli version + installed agent ids
 * (and, when `withVersions`, the installed version strings per agent). */
export function probeDevice(device: DeviceProfile, opts?: ProbeOptions): DeviceProbe {
  let target: string;
  try {
    target = sshTargetFor(device);
  } catch (e) {
    return { device: device.name, reachable: false, platform: device.platform, installedAgents: [], note: (e as Error).message };
  }
  const hint = osHint(device.platform);
  const ready = readyProbe(target, hint);
  if (!ready.reachable) {
    return { device: device.name, reachable: false, platform: device.platform, installedAgents: [], note: 'unreachable' };
  }
  let installed: string[] = [];
  const remoteCmd = buildRemoteAgentsInvocation(['teams', 'doctor', '--json'], undefined, hint, remoteEnv(device.platform));
  const res = sshExec(target, remoteCmd, { timeoutMs: 30000, multiplex: true });
  if (res.code === 0) {
    try {
      const map = JSON.parse(res.stdout) as Record<string, TeamsDoctorEntry>;
      installed = Object.entries(map).filter(([, e]) => e?.installed).map(([k]) => k);
    } catch {
      /* agents-cli present but doctor output unparsable — treat as no agents */
    }
  }
  let installedVersions: Record<string, string[]> | undefined;
  if (opts?.withVersions) {
    const viewCmd = buildRemoteAgentsInvocation(['view', '--json'], undefined, hint, remoteEnv(device.platform));
    const vres = sshExec(target, viewCmd, { timeoutMs: 30000, multiplex: true });
    if (vres.code === 0) installedVersions = parseInstalledVersions(vres.stdout);
  }
  return {
    device: device.name,
    reachable: true,
    platform: device.platform,
    cliVersion: ready.version ?? undefined,
    installedAgents: installed,
    installedVersions,
  };
}

export interface ApplyStep {
  kind: FleetAction['kind'];
  ok: boolean;
  detail: string;
}

export interface DeviceApplyResult {
  device: string;
  ok: boolean;
  steps: ApplyStep[];
  note?: string;
}

export interface ExecContext {
  targetCliVersion: string;
  source: string;
  sourceAuth: SourceAuth;
  /** Set for a dry run — probe + plan only, execute nothing. */
  dryRun?: boolean;
}

/** Execute one device's planned actions in order. Real SSH — no mocks. */
export function reconcileDevice(row: DeviceDiff, device: DeviceProfile, ctx: ExecContext): DeviceApplyResult {
  if (!row.probe.reachable) {
    return { device: row.device, ok: false, steps: [], note: row.probe.note ?? 'unreachable' };
  }
  const steps: ApplyStep[] = [];
  let target: string;
  try {
    target = sshTargetFor(device);
  } catch (e) {
    return { device: row.device, ok: false, steps: [], note: (e as Error).message };
  }
  const hint = osHint(device.platform);
  const env = remoteEnv(device.platform);
  let ok = true;

  const sshAgents = (args: string[], input?: string) =>
    sshExec(target, buildRemoteAgentsInvocation(args, undefined, hint, env), { timeoutMs: 300000, multiplex: true, input });

  // 1. agents-cli install/upgrade.
  const cliAction = row.actions.find((a) => a.kind === 'install-cli' || a.kind === 'upgrade-cli');
  if (cliAction) {
    const r = bootstrapAgentsCli(target, ctx.targetCliVersion, hint);
    steps.push({ kind: cliAction.kind, ok: r.ok, detail: cliAction.detail });
    ok = ok && r.ok;
  }

  // 2. agents. Every add-agent action carries the full spec (set in diffFleet);
  // install it directly rather than re-parsing the human-readable detail string.
  for (const a of row.actions.filter((x) => x.kind === 'add-agent')) {
    const spec = a.spec!;
    const r = sshAgents(['add', spec, '--yes']);
    steps.push({ kind: 'add-agent', ok: r.code === 0, detail: a.detail });
    ok = ok && r.code === 0;
  }

  // 3. config sync — one `agents sync <scope>` per declared scope. Each scope is
  // a positional repo target (system/user/project/alias); a bare `agents sync`
  // would ignore the profile's declared scopes entirely.
  if (row.actions.some((a) => a.kind === 'sync-config')) {
    const scopes = row.desired.sync.length > 0 ? row.desired.sync : [''];
    let syncOk = true;
    for (const scope of scopes) {
      const r = sshAgents(scope ? ['sync', scope] : ['sync']);
      syncOk = syncOk && r.code === 0;
    }
    steps.push({ kind: 'sync-config', ok: syncOk, detail: `sync config (${row.desired.sync.join(', ') || 'default'})` });
    ok = ok && syncOk;
  }

  // 4. login propagation — one bundle for all pushable agents on this device.
  const pushAgents = [...new Set(row.actions.filter((a) => a.kind === 'push-login').map((a) => a.agent!))];
  if (pushAgents.length > 0) {
    const files: AuthFilePayload[] = [];
    for (const agent of pushAgents) files.push(...(ctx.sourceAuth.filesByAgent.get(agent) ?? []));
    const bundle = buildAuthBundle(ctx.source, files);
    const r = sshAgents(['apply', '--recv-auth'], JSON.stringify(bundle));
    steps.push({ kind: 'push-login', ok: r.code === 0, detail: `propagate login: ${pushAgents.join(', ')}` });
    ok = ok && r.code === 0;
  }

  // Surface blocked logins as (non-fatal) informational steps.
  for (const blocked of row.loginBlocked) {
    steps.push({ kind: 'needs-login', ok: false, detail: `${blocked} needs a manual login (\`agents ssh ${row.device} -- ${blocked}\`)` });
  }
  // Surface declared secrets bundles as (non-fatal) manual-recreate reminders —
  // values are keychain-local, never captured or pushed.
  for (const bundle of row.secretsNeeded) {
    steps.push({ kind: 'needs-secret', ok: false, detail: `secrets bundle '${bundle}' must exist on ${row.device} (\`agents ssh ${row.device} -- secrets create ${bundle}\`)` });
  }

  return { device: row.device, ok, steps };
}

/** Run a pool of async tasks with a concurrency cap, preserving input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Reconcile every device row in parallel (capped). */
export async function runFleetApply(
  rows: DeviceDiff[],
  nameToProfile: Map<string, DeviceProfile>,
  ctx: ExecContext,
  concurrency = 6,
): Promise<DeviceApplyResult[]> {
  return pool(rows, concurrency, async (row) => {
    const profile = nameToProfile.get(row.device);
    if (!profile) return { device: row.device, ok: false, steps: [], note: 'no device profile' };
    return reconcileDevice(row, profile, ctx);
  });
}

/** Default home for source snapshots (overridable in tests). */
export function sourceHome(): string {
  return os.homedir();
}
