/**
 * Native-home materializer (PHNX-3838).
 *
 * `materializeAgentPackage` is the harness-adapter layer: it takes the ONE
 * canonical result `resolveAgentPackage` already decided and projects it into
 * a fresh, isolated native home for one harness (Claude Code, Codex, or
 * OpenCode). It reuses the codebase's existing native-projection primitives
 * instead of re-deriving per-harness format knowledge:
 *
 *   - `agentConfigDirName` / `AGENTS[..].capabilities.rules.file` (agent-spec/agents.ts)
 *     for instructions placement
 *   - `subagentTarget(...)` + its registered transforms (subagents-registry.ts)
 *     for subagent projection
 *   - `writeMcpConfig` (lib/mcp.ts) for per-harness MCP config format
 *   - `registerHooksToSettings` (lib/hooks/install.ts) for per-harness hook
 *     registration, including its stale-registration GC
 *
 * It writes a deterministic, unsigned `materialization-receipt.json` — every
 * `target` path it lists is a path THIS materializer owns, so a second run
 * whose resource set shrank can prune exactly those paths without touching
 * anything else in the output home.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, ManifestHook } from '../types.js';
import { supports } from '../capabilities.js';
import { AGENTS, agentConfigDirName, getMcpConfigPathForHome } from './agents.js';
import { getHooksDirInHome } from '../hooks/install.js';
import { registerHooksToSettings } from '../hooks/install.js';
import { writeMcpConfig } from '../mcp.js';
import type { WritableMcpServer } from '../mcp.js';
import { subagentTarget } from '../subagents-registry.js';
import { AgentPackageError } from './package-types.js';
import type {
  MaterializationReceipt,
  MaterializationReceiptEntry,
  MaterializeOptions,
  PackageResourceKind,
  ResolvedAgentPackage,
  ResolvedResource,
} from './package-types.js';
import { effectiveResources } from './package-resolve.js';

const RECEIPT_FILE = 'materialization-receipt.json';

const KIND_TO_CAPABILITY: Record<PackageResourceKind, 'rules' | 'skills' | 'subagents' | 'mcp' | 'hooks'> = {
  instructions: 'rules',
  skills: 'skills',
  subagents: 'subagents',
  mcp: 'mcp',
  hooks: 'hooks',
};

const COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', 'node_modules']);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || COPY_IGNORE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function removePath(p: string): void {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Fail closed: every effective resource's kind must be a supported capability on this harness+version. */
function assertCapabilitiesSupported(resources: ResolvedResource[], harness: AgentId, harnessVersion: string): void {
  const unsupported: string[] = [];
  for (const r of resources) {
    const cap = KIND_TO_CAPABILITY[r.kind];
    const result = supports(harness, cap, harnessVersion);
    if (!result.ok) {
      const need = 'need' in result && result.need ? ` (need ${result.need})` : '';
      unsupported.push(`${r.kind} '${r.name}' requires capability '${cap}' on ${harness}${need}`);
    }
  }
  if (unsupported.length > 0) {
    throw new AgentPackageError(
      `${harness}@${harnessVersion} cannot materialize this package: ${unsupported.length} unsupported capability request(s)`,
      'unsupported-capability',
      unsupported,
    );
  }
}

function materializeInstructions(resource: ResolvedResource, harness: AgentId, outputHome: string): string {
  const cap = AGENTS[harness].capabilities.rules;
  if (cap === false) {
    throw new AgentPackageError(`${harness} has no instructions target (rules capability is false)`, 'unsupported-capability');
  }
  const agentDir = path.join(outputHome, agentConfigDirName(harness));
  const destFile = path.join(agentDir, cap.file);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(resource.sourcePath, destFile);
  return path.relative(outputHome, destFile);
}

function materializeSkill(resource: ResolvedResource, harness: AgentId, outputHome: string): string {
  const agentDir = path.join(outputHome, agentConfigDirName(harness));
  const destDir = path.join(agentDir, 'skills', resource.name);
  removePath(destDir);
  copyDir(resource.sourcePath, destDir);
  return path.relative(outputHome, destDir);
}

function materializeSubagent(resource: ResolvedResource, harness: AgentId, outputHome: string): string {
  const target = subagentTarget(harness);
  if (!target) {
    throw new AgentPackageError(`${harness} has no subagent target registered`, 'unsupported-capability');
  }
  const dir = target.dir(outputHome);
  target.write(dir, { name: resource.name, path: resource.sourcePath });
  const occupied = target.occupied(dir, resource.name)[0];
  return path.relative(outputHome, occupied.path);
}

/** MCP servers write into one shared per-harness config file; collect then write once for determinism. */
function materializeMcp(resources: ResolvedResource[], harness: AgentId, outputHome: string): string[] {
  if (resources.length === 0) return [];
  const servers: WritableMcpServer[] = resources.map((r) => ({
    name: r.mcp!.name,
    transport: r.mcp!.transport,
    command: r.mcp!.command,
    args: r.mcp!.args,
    env: r.mcp!.env,
    url: r.mcp!.url,
    headers: r.mcp!.headers,
  }));
  const configPath = getMcpConfigPathForHome(harness, outputHome);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    writeMcpConfig(harness, configPath, servers, 'overwrite');
  } catch (err) {
    throw new AgentPackageError(`${harness}: cannot write mcp config — ${(err as Error).message}`, 'unsupported-capability');
  }
  const rel = path.relative(outputHome, configPath);
  return resources.map(() => rel);
}

function materializeHooks(resources: ResolvedResource[], harness: AgentId, outputHome: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (resources.length === 0) return targets;
  const hooksDir = getHooksDirInHome(harness, outputHome);
  fs.mkdirSync(hooksDir, { recursive: true });
  const manifest: Record<string, ManifestHook> = {};
  for (const r of resources) {
    const { def, scriptPath } = r.hook!;
    const destScript = path.join(hooksDir, `${r.name}${path.extname(scriptPath)}`);
    fs.copyFileSync(scriptPath, destScript);
    fs.chmodSync(destScript, 0o755);
    manifest[r.name] = { script: destScript, events: def.events, matcher: def.matcher, timeout: def.timeout };
    targets.set(r.name, path.relative(outputHome, destScript));
  }
  const result = registerHooksToSettings(harness, outputHome, manifest);
  if (result.errors.length > 0) {
    throw new AgentPackageError(`${harness}: failed to register hook(s) — ${result.errors.join('; ')}`, 'invalid-resource');
  }
  return targets;
}

/** Deterministic package ref used in the receipt — `<slug>@<manifest-digest-prefix>`, since packages carry no separate semver here. */
function packageRef(resolved: ResolvedAgentPackage): string {
  return `${resolved.manifest.slug}@${resolved.digest.slice(0, 12)}`;
}

/** Delete any path this materializer owned in a PRIOR run of this exact output home that is no longer part of the current resource set. */
function pruneStaleManagedPaths(outputHome: string, previousTargets: Set<string>, currentTargets: Set<string>): void {
  for (const rel of previousTargets) {
    if (currentTargets.has(rel)) continue;
    removePath(path.join(outputHome, rel));
  }
}

function readPriorReceipt(outputHome: string): MaterializationReceipt | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputHome, RECEIPT_FILE), 'utf-8')) as MaterializationReceipt;
  } catch {
    return null;
  }
}

/**
 * Materialize `resolved` into a fresh native home for `options.harness`. Fails
 * closed (throws `AgentPackageError`, writes nothing new) when the harness is
 * not declared supported by the package, or when any effective resource needs
 * a capability the harness+version does not have. Idempotent and
 * deterministic: re-running against the same `outputHome` with the same
 * inputs produces a byte-identical receipt and prunes any managed path this
 * materializer previously wrote that the current resource set no longer needs.
 */
export function materializeAgentPackage(resolved: ResolvedAgentPackage, options: MaterializeOptions): MaterializationReceipt {
  const { harness, harnessVersion, outputHome } = options;
  if (!resolved.manifest.execution.harnesses.supported.includes(harness)) {
    throw new AgentPackageError(
      `package '${resolved.manifest.slug}' does not declare '${harness}' as a supported harness`,
      'unsupported-harness',
      resolved.manifest.execution.harnesses.supported,
    );
  }

  const resources = effectiveResources(resolved, harness);
  assertCapabilitiesSupported(resources, harness, harnessVersion);

  fs.mkdirSync(outputHome, { recursive: true });
  const prior = readPriorReceipt(outputHome);
  const previousTargets = new Set((prior?.resources ?? []).map((r) => r.target));

  const entries: MaterializationReceiptEntry[] = [];
  const mcpResources = resources.filter((r) => r.kind === 'mcp');
  const hookResources = resources.filter((r) => r.kind === 'hooks');
  const mcpTargets = materializeMcp(mcpResources, harness, outputHome);
  const hookTargets = materializeHooks(hookResources, harness, outputHome);

  for (const r of resources) {
    let target: string;
    if (r.kind === 'instructions') target = materializeInstructions(r, harness, outputHome);
    else if (r.kind === 'skills') target = materializeSkill(r, harness, outputHome);
    else if (r.kind === 'subagents') target = materializeSubagent(r, harness, outputHome);
    else if (r.kind === 'mcp') target = mcpTargets[mcpResources.indexOf(r)];
    else target = hookTargets.get(r.name)!;
    entries.push({ kind: r.kind, name: r.name, target, sha256: r.sha256, provenance: r.provenance });
  }

  const currentTargets = new Set(entries.map((e) => e.target));
  pruneStaleManagedPaths(outputHome, previousTargets, currentTargets);

  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    agent: { ref: packageRef(resolved), digest: `sha256:${resolved.digest}` },
    harness: { id: harness, version: harnessVersion },
    resources: entries,
    warnings: [],
  };
  fs.writeFileSync(path.join(outputHome, RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/** Lowercase hex sha256 of arbitrary bytes — exposed for callers that want to verify the receipt file's own digest (Factory's observed-digest record). */
export function sha256OfReceiptFile(receiptPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
}
