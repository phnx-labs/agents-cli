/**
 * Actor provenance -- who initiated a run.
 *
 * One shared account means every session, commit, and event otherwise shows up
 * as the same person. `resolveActor()` answers "which human is behind this run"
 * by looking at how the process was reached:
 *
 *   - Over SSH (the shared-fleet case): `tailscale whois` the SSH client IP to
 *     the connecting tailnet identity -- a real name + login email.
 *   - Locally (non-SSH): we can't honestly say who is at the box, so the id is
 *     `UNRESOLVED@<host>` and no personal git identity is claimed.
 *   - Inherited: a child spawn trusts the `AGENTS_ACTOR*` env its parent
 *     stamped rather than re-resolving, so the whole spawn tree shares one actor.
 *
 * The resolved actor rides the child-process env (`actorEnv()`, merged into
 * `buildExecEnv`). When the actor is a resolved human, that env also carries
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so the agent's own `git commit` is credited
 * to the person instead of the shared account.
 *
 * The optional `actors:` map in agents.yaml enriches or overrides a resolved
 * identity (pin a work email, add a github handle, mark an entry as an agent).
 */
import { spawnSync } from 'child_process';
import { machineId } from './machine-id.js';
import { parseSshConnection } from './session/provenance.js';
import { readMeta } from './state.js';
import type { ActorConfig } from './types.js';

export type ActorKind = 'human' | 'agent';

export interface ResolvedActor {
  /**
   * Stable id for the responsible entity: the tailnet login (usually an email)
   * for a resolved human, or `UNRESOLVED@<host>` when it can't be determined.
   */
  id: string;
  kind: ActorKind;
  /** Human-readable name, for git author + display. */
  name?: string;
  /** Email, for git author + as a durable key. */
  email?: string;
  /** GitHub handle, when the actors map records one. */
  github?: string;
}

/** Result of `tailscale whois --json <ip>` we care about. */
export interface WhoisIdentity {
  login?: string;
  displayName?: string;
}

/** Hard cap on the whois shell-out — it runs on the spawn hot path. */
const WHOIS_TIMEOUT_MS = 2000;

/**
 * Resolve the tailnet identity behind an IP via `tailscale whois`. Returns
 * undefined when tailscale is absent, the peer is unknown, the call fails, or it
 * exceeds WHOIS_TIMEOUT_MS -- every one of those falls back to an unresolved
 * actor, never an error and never a hang (a wedged tailscaled is timed out, not
 * waited on, since this sits in buildExecEnv on every agent spawn).
 */
function tailscaleWhois(ip: string): WhoisIdentity | undefined {
  try {
    const res = spawnSync('tailscale', ['whois', '--json', ip], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: WHOIS_TIMEOUT_MS,
    });
    // A timeout leaves status null (child killed by SIGTERM) -- the status guard
    // below treats it as an unresolved actor, same as any other failure.
    if (res.status !== 0 || !res.stdout) return undefined;
    const data = JSON.parse(res.stdout) as { UserProfile?: { LoginName?: string; DisplayName?: string } };
    const up = data.UserProfile;
    if (!up) return undefined;
    return { login: up.LoginName, displayName: up.DisplayName };
  } catch {
    return undefined;
  }
}

/** Read the actors map from config, tolerant of a missing/unreadable config. */
function readActors(): Record<string, ActorConfig> {
  try {
    return readMeta().actors ?? {};
  } catch {
    return {};
  }
}

/**
 * Find the actors-map entry for a resolved tailnet login. Matches on an entry's
 * explicit `login`, its map key, or its `email` (all case-insensitive).
 */
function findActorConfig(login: string, actors: Record<string, ActorConfig>): ActorConfig | undefined {
  const needle = login.toLowerCase();
  for (const [key, cfg] of Object.entries(actors)) {
    const candidates = [cfg.login, key, cfg.email].filter((v): v is string => !!v);
    if (candidates.some((c) => c.toLowerCase() === needle)) return cfg;
  }
  return undefined;
}

/**
 * Map a resolved tailnet identity (+ the actors map) to a ResolvedActor. Pure --
 * the impure whois/config reads happen in computeActor -- so the enrich/override
 * path is fully testable. No login (local, or an unnameable peer) yields the
 * honest `UNRESOLVED@<host>`; a login without a config entry still credits git
 * from the tailnet DisplayName + login email.
 */
export function actorFromIdentity(
  who: WhoisIdentity | undefined,
  host: string,
  actors: Record<string, ActorConfig>,
): ResolvedActor {
  const login = who?.login;
  if (!login) {
    return { id: `UNRESOLVED@${host}`, kind: 'human' };
  }
  const cfg = findActorConfig(login, actors);
  const emailFromLogin = login.includes('@') ? login : undefined;
  return {
    id: login,
    kind: cfg?.kind ?? 'human',
    name: cfg?.name ?? who?.displayName,
    email: cfg?.email ?? emailFromLogin,
    github: cfg?.github,
  };
}

/** Reconstruct an actor an ancestor process already resolved into the env. */
function inheritedActor(env: NodeJS.ProcessEnv): ResolvedActor | undefined {
  const id = env.AGENTS_ACTOR;
  if (!id) return undefined;
  return {
    id,
    kind: env.AGENTS_ACTOR_KIND === 'agent' ? 'agent' : 'human',
    name: env.AGENTS_ACTOR_NAME || undefined,
    email: env.AGENTS_ACTOR_EMAIL || undefined,
    github: env.AGENTS_ACTOR_GITHUB || undefined,
  };
}

/**
 * Compute the actor for a given environment. Pure with respect to `env` (the
 * only impurity is the `tailscale whois` / config read on the fresh-SSH path),
 * so tests can drive every branch by passing an env explicitly.
 */
export function computeActor(env: NodeJS.ProcessEnv = process.env): ResolvedActor {
  const inherited = inheritedActor(env);
  if (inherited) return inherited;

  const ssh = env.SSH_CONNECTION ? parseSshConnection(env.SSH_CONNECTION) : undefined;
  const who = ssh?.clientIp ? tailscaleWhois(ssh.clientIp) : undefined;
  return actorFromIdentity(who, machineId(), readActors());
}

let cached: ResolvedActor | undefined;

/**
 * Resolve the actor for the current process, cached for the process lifetime
 * (the SSH `whois` shell-out runs at most once).
 */
export function resolveActor(): ResolvedActor {
  if (!cached) cached = computeActor(process.env);
  return cached;
}

/** Clear the per-process cache. For tests, and for env changes within a run. */
export function resetActorCache(): void {
  cached = undefined;
}

/**
 * The env an actor propagates to child processes. Always carries the actor id +
 * kind (so children inherit and don't re-resolve). For a resolved human with a
 * real name and email, it also carries `GIT_AUTHOR_*` / `GIT_COMMITTER_*` so the
 * agent's own commits are credited to the person, not the shared account. An
 * unresolved actor sets no git identity -- git keeps its ambient config.
 */
export function actorEnv(actor: ResolvedActor): Record<string, string> {
  const env: Record<string, string> = {
    AGENTS_ACTOR: actor.id,
    AGENTS_ACTOR_KIND: actor.kind,
  };
  if (actor.name) env.AGENTS_ACTOR_NAME = actor.name;
  if (actor.email) env.AGENTS_ACTOR_EMAIL = actor.email;
  if (actor.github) env.AGENTS_ACTOR_GITHUB = actor.github;

  if (actor.kind === 'human' && actor.name && actor.email) {
    env.GIT_AUTHOR_NAME = actor.name;
    env.GIT_AUTHOR_EMAIL = actor.email;
    env.GIT_COMMITTER_NAME = actor.name;
    env.GIT_COMMITTER_EMAIL = actor.email;
  }
  return env;
}
