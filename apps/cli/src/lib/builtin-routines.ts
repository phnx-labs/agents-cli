/**
 * Built-in, daemon-owned routine definitions (RUSH-2465).
 *
 * These 6 "daemon housekeeping tick" routines used to be shipped as YAML files
 * in the config repo (`gh:phnx-labs/.agents-system` `routines/*.yml`), pulled
 * onto every install. RUSH-2353 had migrated them off hardcoded daemon
 * `setInterval`s to gain declaration, run history, pause, and device pin; but a
 * daemon's own housekeeping does not belong in the config repo every install
 * pulls — it belongs to the daemon.
 *
 * So the daemon now OWNS the definitions: they are injected as the lowest layer
 * of `listJobs()` / `readJob()` (`routines.ts`), below project > user > system.
 * The same pid-claimed `JobScheduler` schedules and fires them, via the existing
 * `agents __daemon-tick <name>` entrypoint (`daemon-ticks.ts`) — so nothing about
 * scheduling, run tracking, pausability, device pinning, or the double-fire
 * safeguards changes; only the HOME of the definition moves from a config-repo
 * file to daemon code. `.agents-system` then ships only `check-updates.yml`.
 *
 * Transition-safe by construction: because these are the *lowest* layer, a
 * same-named on-disk routine (the `.agents-system` YAML that is still shipped
 * until its removal PR merges, or a user override in `~/.agents/routines/`)
 * shadows the built-in — so exactly one definition ever fires. Once the
 * `.agents-system` files are removed, the built-in becomes the active
 * definition with no gap and byte-identical schedule/command.
 *
 * The `schedule`/`timeout` values here mirror the shipped YAML exactly. Usage
 * and authentication health are excluded because `account-state-service.ts`
 * owns those first-party caches directly inside the daemon.
 */

import type { JobConfig } from './routines.js';

/** One built-in routine's schedulable knobs. `name` maps 1:1 to a `DAEMON_TICKS` body. */
interface BuiltinRoutineSpec {
  name: string;
  /** Cron expression — the same clock the shipped YAML used. */
  schedule: string;
  /** Per-run timeout, mirroring the YAML. */
  timeout: string;
}

/**
 * The 6 daemon-owned housekeeping routines. Schedules and timeouts are copied
 * verbatim from the `.agents-system` `routines/*.yml` they replace (RUSH-2353).
 *
 * NOT included: `check-updates` — that is genuine user-facing config sync
 * (`agents repo pull system`), so it stays a system routine and is untouched.
 */
const BUILTIN_ROUTINE_SPECS: readonly BuiltinRoutineSpec[] = Object.freeze([
  // Publish THIS host's local active sessions snapshot. Publish-own only (RUSH-2062).
  { name: 'session-cache-warm', schedule: '*/3 * * * *', timeout: '2m' },
  // Refresh device reachability + detect new tailnet nodes (own host's view).
  { name: 'device-probe', schedule: '*/3 * * * *', timeout: '2m' },
  // Pick up delegated Todo Linear tickets and dispatch them. SHARED INPUT:
  // needs an owner pin (`agents routines devices auto-dispatch --set <one>`) —
  // preserved because this is still a routine (see below).
  { name: 'auto-dispatch', schedule: '*/3 * * * *', timeout: '2m' },
  // Nudge stalled agent sessions (this host's own sessions).
  { name: 'watchdog', schedule: '*/3 * * * *', timeout: '2m' },
  // Retrofit the guarded tmux pane-died hook onto this host's managed sessions.
  { name: 'tmux-reconcile', schedule: '*/5 * * * *', timeout: '2m' },
  // Probe each agent's default version actually launches; repair a gutted install.
  { name: 'launch-health', schedule: '0 */6 * * *', timeout: '5m' },
]);

/** Frozen list of the built-in routine names, in declaration order. */
export const BUILTIN_ROUTINE_NAMES: readonly string[] = Object.freeze(
  BUILTIN_ROUTINE_SPECS.map((s) => s.name),
);

/** Whether `name` is a daemon-owned built-in routine. */
export function isBuiltinRoutine(name: string): boolean {
  return BUILTIN_ROUTINE_NAMES.includes(name);
}

/**
 * Build one built-in routine's fully-formed `JobConfig`. Command routines carry
 * no prompt/agent — the `command:` is `agents __daemon-tick <name>`, the exact
 * form the shipped YAML used, so the tick body (`daemon-ticks.ts`) runs
 * unchanged. Defaults mirror `JOB_DEFAULTS` in routines.ts (mode/effort auto);
 * `enabled: true` is the intrinsic default that `applyDeviceActivation` then
 * overlays with this device's activation-manifest membership, exactly as it
 * does for an on-disk system routine.
 */
function toJobConfig(spec: BuiltinRoutineSpec): JobConfig {
  return {
    name: spec.name,
    schedule: spec.schedule,
    command: `agents __daemon-tick ${spec.name}`,
    mode: 'auto',
    effort: 'auto',
    timeout: spec.timeout,
    enabled: true,
    prompt: '',
    builtin: true,
  };
}

/**
 * The daemon-owned built-in routine configs — a fresh array each call (callers
 * mutate the returned list, e.g. `applyDeviceActivation`). Consumed by
 * `listJobs()` / `readJob()` as the lowest definition layer.
 */
export function builtinRoutineJobs(): JobConfig[] {
  return BUILTIN_ROUTINE_SPECS.map(toJobConfig);
}

/** Look up one built-in routine config by name, or null if not a built-in. */
export function builtinRoutineJob(name: string): JobConfig | null {
  const spec = BUILTIN_ROUTINE_SPECS.find((s) => s.name === name);
  return spec ? toJobConfig(spec) : null;
}
