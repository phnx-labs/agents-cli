/**
 * The engine — turns requests into open surfaces.
 *
 * `specForRequest` and `buildRequests` are pure (planning); `openSurface` and
 * `openSurfaces` add the side-effecting transport. A batch runs sequentially and
 * staggered so a `split-right` lands in the tab that was just opened (the split
 * targets the front pane).
 */
import type { Backend, EngineContext, LaunchRequest, LaunchResult, LaunchSpec } from './types.js';
import { BACKENDS } from './backends/index.js';
import { planLayouts, type Packing } from './policy.js';
import { runSpec, type HostResolver } from './transport.js';

const DEFAULT_STAGGER_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The concrete launch command for a request (pure — no side effects). */
export function specForRequest(req: LaunchRequest): LaunchSpec {
  const backend = BACKENDS[req.backend];
  if (!backend) throw new Error(`unknown backend: ${req.backend}`);
  if (req.layout === 'tab') return backend.buildTab(req.cwd, req.command);
  return backend.buildSplit(req.cwd, req.command, req.layout === 'split-down' ? 'down' : 'right');
}

export interface OpenOptions {
  resolveHost?: HostResolver;
  ctx?: EngineContext;
}

/** Open a single surface for one request. Never throws — failures come back in the result. */
export async function openSurface(req: LaunchRequest, opts: OpenOptions = {}): Promise<LaunchResult> {
  let spec: LaunchSpec;
  try {
    spec = specForRequest(req);
  } catch (err: any) {
    return { ok: false, request: req, error: err?.message ?? String(err) };
  }
  const res = await runSpec(spec, req.host, opts.resolveHost);
  return { ok: res.ok, request: req, error: res.error };
}

/** One command to run as a surface. */
export interface SurfaceItem {
  cwd: string;
  command: string[];
}

export interface BuildRequestsOptions {
  backend: Backend;
  host?: string;
  packing?: Packing;
}

/** Turn a list of commands into layout-assigned requests (pure — the planning step). */
export function buildRequests(items: SurfaceItem[], opts: BuildRequestsOptions): LaunchRequest[] {
  const layouts = planLayouts(items.length, opts.packing ?? 'two-per-tab');
  return items.map((item, i) => ({
    backend: opts.backend,
    layout: layouts[i],
    cwd: item.cwd,
    command: item.command,
    host: opts.host,
  }));
}

export interface OpenManyOptions extends OpenOptions, BuildRequestsOptions {
  staggerMs?: number;
}

/**
 * Open many surfaces, applying the layout policy (default: two-per-tab).
 * Sequential + staggered so each split follows the tab it splits.
 */
export async function openSurfaces(items: SurfaceItem[], opts: OpenManyOptions): Promise<LaunchResult[]> {
  const requests = buildRequests(items, opts);
  const stagger = opts.staggerMs ?? DEFAULT_STAGGER_MS;
  const results: LaunchResult[] = [];
  for (let i = 0; i < requests.length; i++) {
    results.push(await openSurface(requests[i], opts));
    if (i < requests.length - 1) await sleep(stagger);
  }
  return results;
}
