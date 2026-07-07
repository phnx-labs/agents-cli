// Per-host inventory + configuration for the Factory Floor host detail pane.
//
// Data path: `agents view [--host <name>] --json --resources all` gives the
// installed agents, versions, accounts, usage, and synced resources on a host
// (over SSH for remotes — the passthrough runs `view` on the target). `agents
// hosts list --json` gives the registry metadata (enrolled / source / caps /
// os). This module parses both, summarizes resource drift, and shells out to
// `agents hosts add|remove` to configure a host. Pure parsers are exported for
// unit tests; the CLI-calling functions cache per host (SSH is expensive).

import { runAgents } from './agentsBin';

const HOST_INVENTORY_TTL_MS = 60_000;
const LOCAL_HOST = 'this-mac';
const RESOURCE_SECTIONS = ['skills', 'plugins', 'mcp', 'commands', 'workflows', 'memory', 'hooks'] as const;
type ResourceSection = (typeof RESOURCE_SECTIONS)[number];

/** Per-version resource counts + how many items have drifted from ~/.agents. */
export interface HostResourceSummary {
  skills: number;
  plugins: number;
  mcp: number;
  commands: number;
  workflows: number;
  memory: number;
  hooks: number;
  /** Resource items whose syncState is not 'synced' (new / modified / deleted). */
  drift: number;
}

export interface HostAgentVersion {
  version: string;
  isDefault: boolean;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Session-window usage percent (0-100+), null when unknown. */
  sessionPercent: number | null;
  weekPercent: number | null;
  lastActive: string | null;
  resources: HostResourceSummary | null;
}

export interface HostAgentInfo {
  agent: string;
  versions: HostAgentVersion[];
}

/** Registry metadata for one host (from `agents hosts list --json`). */
export interface HostMeta {
  name: string;
  enrolled: boolean;
  source: string | null; // 'ssh-config' | 'inline'
  target: string | null; // inline address, or the ssh-config alias
  user: string | null;
  os: string | null;
  caps: string[];
  addedAt: string | null;
  status: string | null; // 'online' | 'offline' | 'unknown'
}

export interface HostInventory {
  host: string;
  reachable: boolean;
  error: string | null;
  meta: HostMeta | null;
  agents: HostAgentInfo[];
  fetchedAt: number;
}

/** Summarize a version's `resources` object into counts + a drift total. */
export function summarizeResources(resources: unknown): HostResourceSummary | null {
  if (!resources || typeof resources !== 'object') return null;
  const r = resources as Record<string, unknown>;
  const summary: HostResourceSummary = {
    skills: 0, plugins: 0, mcp: 0, commands: 0, workflows: 0, memory: 0, hooks: 0, drift: 0,
  };
  for (const sec of RESOURCE_SECTIONS) {
    const items = Array.isArray(r[sec]) ? (r[sec] as Array<Record<string, unknown>>) : [];
    summary[sec as ResourceSection] = items.length;
    for (const it of items) {
      const s = it?.syncState;
      if (typeof s === 'string' && s !== 'synced') summary.drift += 1;
    }
  }
  return summary;
}

function windowPercent(windows: unknown, key: string): number | null {
  if (!Array.isArray(windows)) return null;
  const w = windows.find((x) => x && typeof x === 'object' && (x as Record<string, unknown>).key === key);
  const pct = w && (w as Record<string, unknown>).usedPercent;
  return typeof pct === 'number' ? pct : null;
}

/** Parse `agents view [--host] --json --resources all` output (array or single). */
export function parseHostAgents(rawJson: string): HostAgentInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [data];
  const out: HostAgentInfo[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.agent !== 'string' || !Array.isArray(e.versions)) continue;
    const rawVersions = (e.versions as unknown[]).filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object',
    );
    const versions: HostAgentVersion[] = rawVersions.map((v) => ({
      version: String(v.version ?? ''),
      isDefault: v.isDefault === true,
      signedIn: v.signedIn === true,
      email: typeof v.email === 'string' ? v.email : null,
      plan: typeof v.plan === 'string' ? v.plan : null,
      sessionPercent: windowPercent(v.windows, 'session'),
      weekPercent: windowPercent(v.windows, 'week'),
      lastActive: typeof v.lastActive === 'string' ? v.lastActive : null,
      resources: summarizeResources(v.resources),
    }));
    out.push({ agent: e.agent, versions });
  }
  return out;
}

/** Find one host's metadata in `agents hosts list --json` output. */
export function parseHostMeta(rawJson: string, host: string): HostMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const h = data.find((x) => x && typeof x === 'object' && (x as Record<string, unknown>).name === host) as
    | Record<string, unknown>
    | undefined;
  if (!h) return null;
  const source = typeof h.source === 'string' ? h.source : null;
  return {
    name: String(h.name),
    enrolled: h.enrolled === true,
    source,
    target: typeof h.address === 'string' ? h.address : source === 'ssh-config' ? String(h.name) : null,
    user: typeof h.user === 'string' ? h.user : null,
    os: typeof h.os === 'string' ? h.os : null,
    caps: Array.isArray(h.caps) ? (h.caps as unknown[]).filter((c): c is string => typeof c === 'string') : [],
    addedAt: typeof h.addedAt === 'string' ? h.addedAt : null,
    status: typeof h.status === 'string' ? h.status : null,
  };
}

/** Single-quote a value for safe interpolation into the runAgents command string. */
function shellArg(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Reject host/cap values that could smuggle shell/flags before they reach the CLI. */
export function isSafeHostToken(value: string): boolean {
  // Host names, ssh aliases, and user@host targets — no spaces, quotes, or shell
  // metachars. A leading char must be alphanumeric so a value like "-x" can't be
  // parsed as a flag by the CLI (argument injection).
  return /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(value) && value.length <= 128;
}
export function isSafeCap(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) && value.length <= 40;
}

const hostCache = new Map<string, { data: HostInventory; fetchedAt: number }>();
const hostInflight = new Map<string, Promise<HostInventory>>();

/** Fetch one host's inventory (installed agents + resources) and registry
 *  metadata. Cached per host for 60s; SSH failures return reachable:false with
 *  whatever metadata was available rather than throwing. */
export async function fetchHostInventory(host: string, force = false): Promise<HostInventory> {
  if (!isSafeHostToken(host)) {
    return { host, reachable: false, error: 'invalid host name', meta: null, agents: [], fetchedAt: Date.now() };
  }
  const now = Date.now();
  const cached = hostCache.get(host);
  if (!force && cached && now - cached.fetchedAt < HOST_INVENTORY_TTL_MS) return cached.data;
  // A forced refresh always re-probes; only non-forced fetches share an in-flight one.
  if (!force) {
    const existing = hostInflight.get(host);
    if (existing) return existing;
  }

  const run = (async (): Promise<HostInventory> => {
    // Registry metadata is a fast local read — best-effort, never fails the fetch.
    let meta: HostMeta | null = null;
    try {
      const { stdout } = await runAgents('hosts list --json', { timeout: 8_000 });
      meta = parseHostMeta(stdout, host);
    } catch {
      /* metadata is optional */
    }

    const isLocal = host === LOCAL_HOST;
    const args = isLocal
      ? 'view --json --resources all'
      : `view --host ${shellArg(host)} --no-tty --json --resources all`;
    try {
      const { stdout } = await runAgents(args, {
        timeout: isLocal ? 15_000 : 30_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { host, reachable: true, error: null, meta, agents: parseHostAgents(stdout), fetchedAt: Date.now() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { host, reachable: false, error: message.slice(0, 200), meta, agents: [], fetchedAt: Date.now() };
    }
  })();

  if (!force) hostInflight.set(host, run);
  try {
    const result = await run;
    hostCache.set(host, { data: result, fetchedAt: Date.now() });
    return result;
  } finally {
    if (!force) hostInflight.delete(host);
  }
}

/** Enroll a host in the registry. `--no-enroll` skips the interactive remote
 *  bootstrap probe (which would hang a non-TTY exec); reachability + inventory
 *  come from the subsequent fetchHostInventory. */
export async function enrollHost(
  name: string,
  opts: { target?: string; caps?: string[]; os?: string } = {},
): Promise<void> {
  if (!isSafeHostToken(name)) throw new Error('invalid host name');
  let args = `hosts add ${shellArg(name)}`;
  if (opts.target) {
    if (!isSafeHostToken(opts.target)) throw new Error('invalid target');
    args += ` ${shellArg(opts.target)}`;
  }
  for (const cap of opts.caps ?? []) {
    if (!isSafeCap(cap)) throw new Error(`invalid capability: ${cap}`);
    args += ` --cap ${shellArg(cap)}`;
  }
  if (opts.os) {
    if (!isSafeCap(opts.os)) throw new Error('invalid os');
    args += ` --os ${shellArg(opts.os)}`;
  }
  args += ' --no-enroll';
  await runAgents(args, { timeout: 60_000 });
  hostCache.delete(name);
}

/** Remove an enrolled host from the registry (does not touch ~/.ssh/config). */
export async function removeHost(name: string): Promise<void> {
  if (!isSafeHostToken(name)) throw new Error('invalid host name');
  await runAgents(`hosts remove ${shellArg(name)}`, { timeout: 15_000 });
  hostCache.delete(name);
}

/** Drop a cached inventory so the next fetch re-probes (used after config changes). */
export function invalidateHostInventory(host?: string): void {
  if (host) hostCache.delete(host);
  else hostCache.clear();
}
