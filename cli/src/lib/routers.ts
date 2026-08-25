/**
 * Router management -- named, task-typed allowlists of (harness, model/tier,
 * account) that constrain an Agent Router decision. A router is a
 * generalization of a profile (a profile ≡ a router pinned to one harness and
 * one account). Stored as YAML files under ~/.agents/routers/.
 *
 * Routers resolve as a layered resource (project > user > system, like other
 * resources -- see resources.ts) but are always CREATED in the user layer,
 * mirroring profiles.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from './state.js';
import { resolveResource, listResources } from './resources.js';
import { ALL_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import { isTierToken, resolveTierMap, MODEL_TIERS } from './model-tiers.js';
import { getModelCatalog } from './models.js';
import { resolveVersion } from './installations/versions.js';

/** Per-harness allowlist inside a router: eligible models/tiers + linked accounts. */
export interface RouterHarnessAllowlist {
  /** Concrete model ids and/or tier tokens (cheap|default|best|ultra) eligible under this router. */
  models: string[];
  /** Durable credential accounts eligible under this router. Routing is limited to these. */
  accounts?: string[];
}

/** A named router: a reusable, task-typed allowlist of harnesses x models/tiers x accounts. */
export interface Router {
  name: string;
  /** Free-text task type this router serves (e.g. "research", "prod-refactor"). */
  task?: string;
  /** Allowlist -- only these harness x model/tier x account combos are eligible under this router. */
  harnesses: Record<string, RouterHarnessAllowlist>;
  /** Scoped policy weights, applied within the router (consumed by routing, a later ticket). */
  weights?: { cost?: number; success?: number; headroom?: number };
  /** Opt-in re-route of a pinned target when it's exhausted (consumed by routing, a later ticket). */
  hijack?: boolean;
}

const ROUTER_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

/** Directory this machine writes router YAML files to (user layer). */
export function routersDir(): string {
  return path.join(getUserAgentsDir(), 'routers');
}

function routerPath(name: string): string {
  return path.join(routersDir(), `${name}.yml`);
}

/** Validate a router name against the allowed pattern. Throws on invalid input. */
export function validateRouterName(name: string): void {
  if (!ROUTER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid router name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

/** Check whether a router resolves, project > user > system (like other resources). */
export function routerExists(name: string, cwd?: string): boolean {
  validateRouterName(name);
  return resolveResource('routers', name, cwd) !== null;
}

/**
 * The layer a router currently resolves from ('project' | 'user' | 'system' |
 * an extra-repo alias), or null if it doesn't resolve. `writeRouter` and
 * `deleteRouter` only ever touch the user layer, so a caller that edits or
 * removes a router MUST check this first -- editing a router that resolves
 * from a non-user layer would silently write to a user-layer file that stays
 * permanently shadowed (the edit "succeeds" but is never read back).
 */
export function routerSource(name: string, cwd?: string): string | null {
  validateRouterName(name);
  return resolveResource('routers', name, cwd)?.source ?? null;
}

function parseRouterFile(file: string, name: string): Router {
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Router;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Router '${name}' is malformed.`);
  }
  if (!parsed.name) parsed.name = name;
  if (!parsed.harnesses || typeof parsed.harnesses !== 'object') parsed.harnesses = {};
  return parsed;
}

/** Read a router, resolved project > user > system. Throws if not found or malformed. */
export function readRouter(name: string, cwd?: string): Router {
  validateRouterName(name);
  const resolved = resolveResource('routers', name, cwd);
  if (!resolved) {
    throw new Error(`Router '${name}' not found.`);
  }
  return parseRouterFile(resolved.path, name);
}

/** Write a router to disk atomically (write-to-tmp then rename). Always writes the user layer. */
export function writeRouter(router: Router): void {
  validateRouterName(router.name);
  const dir = routersDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify(router);
  const file = routerPath(router.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

/** Delete a router from the user layer. Returns false if it did not exist there. */
export function deleteRouter(name: string): boolean {
  validateRouterName(name);
  const file = routerPath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/**
 * Fail-loud token validation (E1 of the Agent Router spec): a router MUST NOT
 * persist a harness id or model/tier token this machine cannot vouch for.
 * Throws naming the first invalid token found; the caller (route.ts) never
 * calls {@link writeRouter} when this throws, so an invalid `create`/`allow`
 * writes nothing.
 *
 * A harness id must be a real, registered agent (`AGENTS` in agents.ts) --
 * checked regardless of whether that harness is installed on this machine,
 * since a router is fleet-wide config and the harness may only run
 * elsewhere. A model/tier token is valid when it is one of the four
 * cross-harness tier tokens (cheap|default|best|ultra, always installable-
 * agnostic), OR a concrete model id this machine can actually verify: either
 * one of the harness's resolved tier rungs (`resolveTierMap` -- covers
 * curated/no-catalog harnesses like Droid with zero install required) or a
 * member of its extracted catalog (`getModelCatalog`, when a version of that
 * harness is installed here). A concrete id for a harness with neither --
 * not installed here, no curated ladder -- cannot be verified and is
 * rejected rather than accepted unverified.
 */
export function validateRouter(router: Router): void {
  for (const [harness, allowlist] of Object.entries(router.harnesses)) {
    if (!(ALL_AGENT_IDS as string[]).includes(harness)) {
      throw new Error(`router '${router.name}': unknown harness '${harness}'. Known harnesses: ${ALL_AGENT_IDS.join(', ')}.`);
    }
    const agent = harness as AgentId;
    for (const token of allowlist.models) {
      if (isTierToken(token)) continue;

      const version = resolveVersion(agent) ?? '0.0.0';
      const tierMap = resolveTierMap(agent, version);
      const tierRungIds = new Set(
        MODEL_TIERS.map((t) => tierMap[t].model).filter((m): m is string => m !== null),
      );
      if (tierRungIds.has(token)) continue;

      const catalog = getModelCatalog(agent, version);
      const inCatalog = catalog
        ? catalog.models.some((m) => m.id === token) || Boolean(catalog.aliases[token])
        : false;
      if (inCatalog) continue;

      throw new Error(
        `router '${router.name}': unknown model '${token}' for harness '${harness}'. ` +
        `Use a tier token (${MODEL_TIERS.join('|')}) or a model id '${harness}' actually ships.`,
      );
    }
  }
}

/**
 * List every router resolved project > user > system (deduplicated union,
 * project wins on a name collision -- same precedence as {@link resolveResource}).
 * Malformed files are silently skipped, surfaced via `agents route show <name>`.
 */
export function listRouters(cwd?: string): Router[] {
  const routers: Router[] = [];
  for (const resolved of listResources('routers', cwd)) {
    try {
      routers.push(parseRouterFile(resolved.path, resolved.name));
    } catch {
      // Skip malformed router files.
    }
  }
  return routers.sort((a, b) => a.name.localeCompare(b.name));
}
