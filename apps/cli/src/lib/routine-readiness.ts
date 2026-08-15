/**
 * Activation readiness for a routine, composed from the target-aware execution
 * context ({@link resolveJobExecutionContext}) plus the harness/target checks a
 * caller can perform on this box (agent installed). This is the gate `add`,
 * `edit`, `doctor`, and `resume` all run before activating a routine: ready →
 * active, any proven blocker → saved paused with a stable code + repair command.
 *
 * Structural context readiness is synchronous for the scheduler. Interactive
 * add/edit/doctor/resume additionally call the live variant below, which probes
 * authentication and Codex's native workspace-trust record before activation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import type { JobConfig } from './scheduling/routines.js';
import { resolveJobExecutionContext, resolveHostStrategy } from './scheduling/routines.js';
import { evaluateRoutineReadiness, type RoutineReadinessResult, type PlacementMode } from './routine-context.js';
import { getVersionHomePath, resolveVersion } from './installations/versions.js';
import { probeLocalFleetAuth } from './auth-health.js';
import { resolveHostRunTarget } from './hosts/run-target.js';
import { hostIdentityArgs, sshTargetFor } from './hosts/types.js';
import { probeHost } from './hosts/ready.js';
import { sshExec, shellQuote } from './ssh-exec.js';
import { encodePowershell, powershellQuote, POWERSHELL_PROGRESS_SILENCE } from './hosts/remote-cmd.js';

/**
 * Evaluate whether a routine is ready to activate on this box. `probeAgent`
 * defaults to "is a version of the routine's agent resolvable" via
 * {@link resolveVersion}; pass a stub in tests to exercise the availability path
 * without an installed harness.
 */
export function evaluateActivationReadiness(
  config: JobConfig,
  deps: { probeAgent?: (agent: string) => boolean } = {},
): RoutineReadinessResult {
  const strategy = resolveHostStrategy(config);
  const mode: PlacementMode = strategy;
  // Local placement inspects this box's filesystem; a remote/cloud target defers
  // existence (its filesystem is unreachable here) and checks portability only.
  const context = resolveJobExecutionContext(config, {
    mode,
    probe: mode === 'local' ? undefined : null,
  });

  const probeAgent = deps.probeAgent ?? ((agent: string) => resolveVersion(agent as never) !== undefined);
  return evaluateRoutineReadiness(
    context,
    {
      // Command routines have no agent to install; workflow routines dispatch
      // through `agents run` (claude under the hood) and are checked at run time.
      agentInstalled: config.agent && !config.workflow && !config.command
        ? () => probeAgent(config.agent!)
        : undefined,
    },
    { agent: config.agent },
  );
}

/** One-line human summary of a blocked readiness result, with its repair. */
export function formatReadinessBlocker(result: RoutineReadinessResult): string {
  if (result.ready || !result.readiness) return 'ready';
  const { code, message, repair } = result.readiness;
  return `${code}: ${message}${repair ? `\n  repair: ${repair}` : ''}`;
}

interface RemoteProjectDefinition {
  name: string;
  root?: string;
  defaultPath?: string;
}

/** Parse the target HOME sentinel and the project catalog returned by one SSH call. */
export function parseRemoteProjectSnapshot(stdout: string): { home: string; projects: RemoteProjectDefinition[] } | undefined {
  const lines = stdout.split(/\r?\n/);
  const homeLine = lines.shift();
  if (!homeLine?.startsWith('__HOME__')) return undefined;
  const home = homeLine.slice('__HOME__'.length);
  if (!home) return undefined;
  try {
    const projects = JSON.parse(lines.join('\n')) as unknown;
    if (!Array.isArray(projects)) return undefined;
    if (!projects.every((entry) => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')) {
      return undefined;
    }
    return { home, projects: projects as RemoteProjectDefinition[] };
  } catch {
    return undefined;
  }
}

/** Build a target-native probe that creates and removes a file in the workspace. */
export function buildRemoteWorkspaceProbe(cwd: string, windows: boolean): string {
  if (windows) {
    return `powershell -NoProfile -EncodedCommand ${encodePowershell(`$d=${powershellQuote(cwd)}; if (-not (Test-Path -LiteralPath $d -PathType Container)) { exit 1 }; $p=Join-Path $d ([IO.Path]::GetRandomFileName()); try { New-Item -ItemType File -Path $p -ErrorAction Stop | Out-Null; Remove-Item -LiteralPath $p -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`)}`;
  }
  const pattern = path.posix.join(cwd, '.agents-routine-readiness.XXXXXX');
  return `probe_path=$(mktemp ${shellQuote(pattern)}) && rm -f "$probe_path"`;
}

/** A successful probe must contain the exact requested postcondition, not merely exit zero. */
export function probeOutputHasSentinel(stdout: string, sentinel: string): boolean {
  const containsExact = (value: unknown): boolean => {
    if (value === sentinel) return true;
    if (Array.isArray(value)) return value.some(containsExact);
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsExact);
    return false;
  };
  return stdout.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === sentinel) return true;
    try { return containsExact(JSON.parse(trimmed)); } catch { return false; }
  });
}

function codexWorkspaceTrusted(version: string, cwd: string): boolean {
  try {
    const configPath = path.join(getVersionHomePath('codex', version), '.codex', 'config.toml');
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, { trust_level?: string }> | undefined;
    return Object.entries(projects ?? {}).some(([root, project]) => {
      if (project.trust_level !== 'trusted') return false;
      const relative = path.relative(root, cwd);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  } catch {
    return false;
  }
}

/**
 * Interactive setup/repair readiness. Unlike the scheduler's deterministic
 * structural gate, this completes a real local auth request and reads Codex's
 * native trust record before add/edit/resume can activate the definition.
 */
export async function evaluateActivationReadinessLive(config: JobConfig): Promise<RoutineReadinessResult> {
  const structural = evaluateActivationReadiness(config);
  if (!structural.ready) return structural;

  const mode = resolveHostStrategy(config);
  if (mode === 'host' && config.host) return evaluateHostActivationReadiness(config);
  if (mode !== 'local' || !config.agent || config.workflow || config.command) return structural;
  const version = resolveVersion(config.agent as never);
  if (!version) return structural;
  const context = resolveJobExecutionContext(config, { mode: 'local' });

  let authVerdict: { ok: boolean; reason?: string };
  const rows = await probeLocalFleetAuth({ agents: [config.agent as never] });
  const row = rows.find((candidate) => candidate.version === version);
  const accepted = new Set(['live', 'rate_limited', 'unverified']);
  authVerdict = row && accepted.has(row.health.verdict)
    ? { ok: true }
    : { ok: false, reason: row?.health.verdict ?? 'unconfigured' };

  return evaluateRoutineReadiness(context, {
    agentInstalled: () => true,
    ...(config.agent === 'codex' && context.absoluteCwd
      ? { codexTrusted: () => codexWorkspaceTrusted(version, context.absoluteCwd!) }
      : {}),
    authOk: () => authVerdict,
  }, { agent: config.agent });
}

/** Resolve and probe the actual SSH target used by a host-placed routine. */
export async function evaluateHostActivationReadiness(config: JobConfig): Promise<RoutineReadinessResult> {
  const host = await resolveHostRunTarget(config.host!);
  const target = sshTargetFor(host);
  const identity = hostIdentityArgs(host);
  if (!probeHost(target, host.os, identity).reachable) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }

  const windows = host.os?.toLowerCase().includes('win') ?? false;
  const homeCommand = windows
    ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; Write-Output ("__HOME__" + $HOME); & agents projects list --json`)}`
    : `bash -lc ${shellQuote('printf "__HOME__%s\\n" "$HOME"; agents projects list --json')}`;
  const projectResult = sshExec(target, homeCommand, { timeoutMs: 20_000, extraSshArgs: identity });
  if (projectResult.code !== 0) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }
  const snapshot = parseRemoteProjectSnapshot(projectResult.stdout);
  if (!snapshot) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }
  const targetHome = snapshot.home;
  const defs = snapshot.projects;
  const def = config.project ? defs.find((candidate) => candidate.name === config.project) : undefined;
  const projectResolution = config.project
    ? (def ? { defined: true as const, base: def.defaultPath ?? def.root } : { defined: false as const })
    : undefined;
  const unprobed = resolveJobExecutionContext(config, { mode: 'host', targetHome, probe: null, projectResolution });
  if (!unprobed.ready || !unprobed.absoluteCwd) return { context: unprobed, ready: false, readiness: unprobed.readiness };

  const check = buildRemoteWorkspaceProbe(unprobed.absoluteCwd, windows);
  const fsResult = sshExec(target, check, { timeoutMs: 12_000, extraSshArgs: identity });
  if (fsResult.code !== 0) {
    return evaluateRoutineReadiness({ ...unprobed, ready: false, readiness: {
      code: 'workspace_not_writable',
      message: `the execution directory is missing or not writable on ${host.name}: ${unprobed.resolvedCwd}`,
    } });
  }

  if (config.agent && !config.workflow && !config.command) {
    if (config.agent === 'codex') {
      const args = ['run', 'codex', 'Reply with exactly ROUTINE_READY', '--mode', 'plan', '--timeout', '45s', '--json'];
      const command = windows
        ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; Set-Location -LiteralPath ${powershellQuote(unprobed.absoluteCwd)}; & agents ${args.map(powershellQuote).join(' ')}`)}`
        : `cd ${shellQuote(unprobed.absoluteCwd)} && agents ${args.map(shellQuote).join(' ')}`;
      const probe = sshExec(target, command, { timeoutMs: 60_000, extraSshArgs: identity });
      if (probe.code !== 0 || !probeOutputHasSentinel(probe.stdout, 'ROUTINE_READY')) {
        const detail = `${probe.stderr}\n${probe.stdout}`.trim();
        const untrusted = detail.includes('trusted directory') || detail.includes('trusted workspace');
        return evaluateRoutineReadiness(unprobed, {
          ...(untrusted ? { codexTrusted: () => false } : { authOk: () => ({ ok: false, reason: detail || 'probe failed' }) }),
        }, { agent: config.agent });
      }
    } else {
      const pingArgs = ['devices', 'ping', '--local', '--json'];
      const command = windows
        ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; & agents ${pingArgs.map(powershellQuote).join(' ')}`)}`
        : `agents ${pingArgs.map(shellQuote).join(' ')}`;
      const probe = sshExec(target, command, { timeoutMs: 30_000, extraSshArgs: identity });
      let verdict = 'error';
      if (probe.code === 0) {
        try {
          const payload = JSON.parse(probe.stdout) as { rows?: Array<{ agent: string; health: { verdict: string } }> };
          verdict = payload.rows?.find((row) => row.agent === config.agent)?.health.verdict ?? 'unconfigured';
        } catch { verdict = 'error'; }
      }
      if (!new Set(['live', 'rate_limited', 'unverified']).has(verdict)) {
        return evaluateRoutineReadiness(unprobed, {
          authOk: () => ({ ok: false, reason: verdict }),
        }, { agent: config.agent });
      }
    }
  }

  return { context: unprobed, ready: true };
}
