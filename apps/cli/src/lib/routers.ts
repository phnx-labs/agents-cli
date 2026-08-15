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
