/**
 * `agents doctor` — diagnostic readout across the install.
 *
 * Two modes:
 *
 *   1. Overview (no target): three sections —
 *      - CLI availability (which agent binaries can be invoked).
 *      - Sync status per default version (fresh / stale / never-synced).
 *      - Orphans per default version per resource type.
 *
 *   2. Target mode: `agents doctor <agent>[@version]` — full per-resource
 *      diff for a single (agent, version) against the current cwd's resolved
 *      sources. Reports ok / DIFF / MISS / EXTRA per resource with the source
 *      layer (project, user, system, extra repo). With `--diff`, renders a
 *      unified diff body for each divergent file. Mirrors the resolution that
 *      the shim drives at runtime: project > user > system > extras.
 *
 * Read-only by default: doctor diagnoses, it doesn't mutate. Pass `--fix` to
 * heal the gaps it finds (install missing resources, repair Claude-invalid
 * plugin manifests, refresh stale plugins, reconcile drift). Run
 * `agents prune cleanup` to act on orphan readouts, or just launch the agent to
 * apply pending sync.
 */
import type { Command } from 'commander';
import { addHostOption } from '../lib/hosts/option.js';
import chalk from 'chalk';
import { checkAllClis } from '../lib/teams/agents.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  getGlobalDefault,
  getVersionHomePath,
  isVersionInstalled,
  listInstalledVersions,
  parseAgentSpec,
} from '../lib/versions.js';
import { loadManifest, isStale } from '../lib/staleness/index.js';
import { diffVersionCommands, iterCommandsCapableVersions } from '../lib/commands.js';
import { diffVersionSkills, iterSkillsCapableVersions } from '../lib/skills.js';
import { iterHooksCapableVersions, listUnmanagedHooksInVersionHome } from '../lib/hooks.js';
import {
  diffVersionResources,
  DOCTOR_ALL_KINDS,
  type DoctorKind,
  type ResourceDiff,
  type VersionResourceReport,
} from '../lib/doctor-diff.js';
import { unifiedDiff, colorizeUnifiedDiff } from '../lib/diff-text.js';
import { listCliStatus } from '../lib/cli-resources.js';
import { setHelpSections } from '../lib/help.js';
import { heal, healChangedAnything, type HealResult } from '../lib/heal.js';
import { blocksLocalScripts, getEffectiveExecutionPolicy } from '../lib/platform/winpath.js';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';
import * as fs from 'fs';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

interface DoctorOptions {
  json?: boolean;
  diff?: boolean;
  kind?: string;
  cwd?: string;
  fix?: boolean;
}

interface SyncStatusRow {
  agent: AgentId;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
  isDefault: boolean;
  /** For stale rows: prioritized lines naming exactly what diverged (plugins first). */
  divergence?: string[];
}

interface OrphanRow {
  agent: AgentId;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

// ─── overview mode (no target) ────────────────────────────────────────────────

// Lines naming exactly what's out of sync for a version, plugins prioritized:
// each divergent plugin gets its own line with specifics (stale mirror version,
// invalid manifest, or the bundled skills/commands missing from the mirror —
// the system-repo plugin content that matters most). Other kinds collapse to
// compact counts so the readout stays scannable.
function divergenceLines(report: VersionResourceReport): string[] {
  const lines: string[] = [];
  for (const p of report.kinds.plugins) {
    if (p.status === 'missing') lines.push(`plugin ${p.name} — not installed`);
    else if (p.status === 'diff') lines.push(`plugin ${p.name} — ${p.detail ?? 'mirror drifted'}`);
  }
  for (const kind of ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents'] as const) {
    const rows = report.kinds[kind];
    const miss = rows.filter((r) => r.status === 'missing').length;
    const dif = rows.filter((r) => r.status === 'diff').length;
    const bits: string[] = [];
    if (miss) bits.push(`${miss} missing`);
    if (dif) bits.push(`${dif} drifted`);
    if (bits.length) lines.push(`${kind.padEnd(11)} ${bits.join(' · ')}`);
  }
  return lines;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function wrapLine(prefix: string, text: string, width = terminalWidth()): string[] {
  const words = collapseWhitespace(text).split(' ').filter(Boolean);
  if (words.length === 0) return [prefix.trimEnd()];
  const continuation = ' '.repeat(stringWidth(prefix));
  const lines: string[] = [];
  let linePrefix = prefix;
  let line = prefix;
  let hasWord = false;
  for (const word of words) {
    const room = Math.max(1, width - stringWidth(linePrefix));
    const piece = stringWidth(word) > room ? truncateToWidth(word, room) : word;
    const candidate = hasWord ? `${line} ${piece}` : `${line}${piece}`;
    if (hasWord && stringWidth(candidate) > width) {
      lines.push(line);
      linePrefix = continuation;
      line = continuation + piece;
      hasWord = true;
    } else {
      line = candidate;
      hasWord = true;
    }
  }
  lines.push(line);
  return lines;
}

function printWrappedLine(prefix: string, text: string): void {
  for (const line of wrapLine(prefix, text)) console.log(chalk.gray(line));
}

function checkSyncStatus(cwd: string): SyncStatusRow[] {
  const rows: SyncStatusRow[] = [];
  // Every installed version, not just the default — a stale NON-default version
  // (e.g. one you launched from yesterday) is exactly the rot that silently
  // serves outdated/invalid resources and that `--fix` now heals. Hiding it here
  // is why that class of bug went unnoticed.
  for (const agent of ALL_AGENT_IDS) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      const manifest = loadManifest(agent, version);
      const status: SyncStatusRow['status'] = !manifest
        ? 'never-synced'
        : isStale(manifest, agent, version, cwd) ? 'stale' : 'fresh';
      const row: SyncStatusRow = { agent, version, status, isDefault: version === def };
      if (status === 'stale') {
        // Resolve the specifics against non-project layers (the global home is
        // never reconciled against per-cwd project resources).
        const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
        const lines = divergenceLines(report);
        if (lines.length) row.divergence = lines;
      }
      rows.push(row);
    }
  }
  return rows;
}

function countOrphans(): OrphanRow[] {
  const byKey = new Map<string, OrphanRow>();

  const ensure = (agent: AgentId, version: string): OrphanRow => {
    const key = `${agent}@${version}`;
    let row = byKey.get(key);
    if (!row) {
      row = { agent, version, commands: 0, skills: 0, hooks: 0 };
      byKey.set(key, row);
    }
    return row;
  };

  for (const { agent, version } of iterCommandsCapableVersions()) {
    const diff = diffVersionCommands(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).commands = diff.orphans.length;
  }
  for (const { agent, version } of iterSkillsCapableVersions()) {
    const diff = diffVersionSkills(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).skills = diff.orphans.length;
  }
  // Orphan hooks are scripts in the version home that no agents.yaml/hooks.yaml
  // entry registers — so the registrar never wires them to an event and they
  // never fire. (Distinct from the source-diff `diffVersionHooks().orphans`,
  // which false-flags valid system-sourced registered hooks.)
  for (const { agent, version } of iterHooksCapableVersions()) {
    const dead = listUnmanagedHooksInVersionHome(agent, version);
    if (dead.length > 0) ensure(agent, version).hooks = dead.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

function renderOverviewText(
  clis: ReturnType<typeof checkAllClis>,
  syncRows: SyncStatusRow[],
  orphanRows: OrphanRow[],
  hostClis: ReturnType<typeof listCliStatus>,
): void {
  console.log(chalk.bold('Agent CLIs'));
  // Show the fleet you actually run — agents that are ready in PATH, plus any
  // you MANAGE (have installed versions) whose binary isn't resolving (a real
  // problem). The other supported-but-unadopted agents collapse to one hint line
  // instead of a column of red "not installed" nags for tools you never wanted.
  const managed = new Set<string>(ALL_AGENT_IDS.filter((a) => listInstalledVersions(a).length > 0));
  const entries = Object.entries(clis);
  const shown = entries.filter(([name, e]) => e.installed || managed.has(name));
  const hidden = entries.filter(([name, e]) => !e.installed && !managed.has(name)).map(([name]) => name);
  if (shown.length === 0) {
    console.log(chalk.gray('  (none installed — `agents add <name>` to start)'));
  } else {
    for (const [name, entry] of shown) {
      const pretty = (AGENT_NAMES[name] || name).padEnd(11);
      if (entry.installed) {
        console.log(`  ${chalk.green('ready')}  ${pretty} ${chalk.gray(entry.path || '')}`);
      } else {
        console.log(`  ${chalk.red('no   ')}  ${pretty} ${chalk.gray(entry.error || 'not installed')}`);
      }
    }
  }
  if (hidden.length > 0) {
    printWrappedLine('  ', `+${hidden.length} more supported (${hidden.join(', ')}) — \`agents add <name>\` to manage`);
  }
  console.log();

  console.log(chalk.bold('Sync status (installed versions)'));
  if (syncRows.length === 0) {
    console.log(chalk.gray('  (no versions installed; add one with `agents add <agent>@<version>`)'));
  } else {
    let anyOutOfSync = false;
    for (const row of syncRows) {
      const tag = row.isDefault ? chalk.gray(' (default)') : '';
      const label = `${AGENT_NAMES[row.agent] || row.agent}@${row.version}${tag}`;
      if (row.status === 'fresh') {
        console.log(`  ${chalk.green('fresh')}  ${label}`);
      } else if (row.status === 'stale') {
        anyOutOfSync = true;
        console.log(`  ${chalk.yellow('stale')}  ${label}  ${chalk.gray('— sources changed since last sync')}`);
        for (const line of row.divergence ?? []) {
          console.log(chalk.gray(`           ${line}`));
        }
      } else {
        anyOutOfSync = true;
        console.log(`  ${chalk.gray('cold ')}  ${label}  ${chalk.gray('— never synced')}`);
      }
    }
    // Launching does NOT reconcile a version home — the shim hot path only
    // resolves a version and compiles project-scoped resources (shims.ts v15/v16).
    // Version homes are reconciled only by management commands, so point at one
    // rather than promising an auto-sync that never happens.
    if (anyOutOfSync) {
      printWrappedLine('  ', 'Reconcile with `agents doctor <agent>@<version> --fix` or `agents sync <agent>@<version>` (not applied on launch).');
    }
  }
  console.log();

  console.log(chalk.bold('Orphans (installed versions)'));
  if (orphanRows.length === 0) {
    console.log(chalk.gray('  (none — version homes match central sources)'));
  } else {
    for (const row of orphanRows) {
      const parts: string[] = [];
      if (row.commands > 0) parts.push(`${row.commands} command${row.commands === 1 ? '' : 's'}`);
      if (row.skills > 0) parts.push(`${row.skills} skill${row.skills === 1 ? '' : 's'}`);
      if (row.hooks > 0) parts.push(`${row.hooks} hook${row.hooks === 1 ? '' : 's'}`);
      const label = `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
      console.log(`  ${chalk.yellow('warn ')}  ${label}  ${chalk.gray(parts.join(', '))}`);
    }
    console.log(chalk.gray('  Run `agents prune cleanup` to remove.'));
  }
  console.log();

  // Host CLIs are host-global (declared in any DotAgents repo's cli/, installed
  // to PATH — not synced into version homes), so they live in the overview, not
  // the per-version resource diff. Source tag shows which repo layer declared
  // each, including user-level and extra repos.
  console.log(chalk.bold('Host CLIs'));
  if (hostClis.statuses.length === 0) {
    console.log(chalk.gray('  (none declared — add one with `agents cli add <name>`)'));
  } else {
    const nameWidth = Math.max(...hostClis.statuses.map((s) => s.manifest.name.length));
    for (const { manifest, installed } of hostClis.statuses) {
      const label = manifest.name.padEnd(nameWidth);
      const src = chalk.gray(`[${manifest.source}]`);
      if (installed) {
        const prefix = `  ${chalk.green('ready')}  ${label}  ${src}`;
        const desc = manifest.description
          ? `  ${truncateToWidth(collapseWhitespace(manifest.description), Math.max(1, terminalWidth() - stringWidth(prefix) - 2))}`
          : '';
        console.log(prefix + chalk.gray(desc));
      } else {
        const prefix = `  ${chalk.red('miss ')}  ${label}  ${src}`;
        const msg = `not installed — run \`agents cli install ${manifest.name}\``;
        const budget = Math.max(1, terminalWidth() - stringWidth(prefix) - 2);
        console.log(prefix + chalk.gray(`  ${truncateToWidth(msg, budget)}`));
      }
    }
  }
  for (const err of hostClis.errors) {
    console.log(`  ${chalk.red('err  ')}  ${chalk.gray(err.file)}: ${chalk.gray(err.reason)}`);
  }

  // On Windows a Restricted/AllSigned execution policy silently breaks the
  // generated `agents.ps1` launcher — postinstall diagnoses it interactively,
  // but a non-interactive install never sees that. Surface it here too.
  renderExecPolicyAdvisory();
}

// ─── windows execution-policy advisory ─────────────────────────────────────────

/**
 * Windows-only advisory lines. When the effective PowerShell execution policy
 * blocks unsigned local `.ps1` scripts (`Restricted`/`AllSigned`), the generated
 * `agents.ps1` launcher fails in PowerShell even when it is on PATH. Surface the
 * remediation; the `.cmd` companion still works, so this is a warning, not an
 * error, and doctor never auto-changes the policy. Pure — returns `[]` on
 * non-Windows or a permissive policy, so it is testable without invoking
 * PowerShell.
 */
export function execPolicyWarningLines(platform: NodeJS.Platform, policy: string | null): string[] {
  if (platform !== 'win32') return [];
  if (!blocksLocalScripts(policy)) return [];
  return [
    `PowerShell execution policy is ${policy} — it blocks the generated agents.ps1 launcher.`,
    'Fix: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
    'The agents.cmd shim still works regardless of the policy.',
  ];
}

function renderExecPolicyAdvisory(): void {
  // Only probe the policy on Windows — getEffectiveExecutionPolicy() spawns
  // powershell, which is a wasted (doomed) process on POSIX where the advisory
  // never applies.
  if (process.platform !== 'win32') return;
  const lines = execPolicyWarningLines(process.platform, getEffectiveExecutionPolicy());
  if (lines.length === 0) return;
  console.log();
  console.log(chalk.bold('Execution policy (Windows)'));
  const [headline, ...rest] = lines;
  console.log(`  ${chalk.yellow('warn ')}  ${headline}`);
  for (const line of rest) {
    console.log(chalk.gray(`           ${line}`));
  }
}

// ─── target mode ──────────────────────────────────────────────────────────────

interface ResolvedTarget {
  agent: AgentId;
  versions: string[];
}

function parseTargetArg(arg: string): ResolvedTarget | { error: string } {
  const at = arg.indexOf('@');
  const agentPart = at === -1 ? arg : arg.slice(0, at);
  const versionPart = at === -1 ? '' : arg.slice(at + 1);

  const agent = resolveAgentName(agentPart);
  if (!agent) return { error: formatAgentError(agentPart) };

  if (!versionPart) {
    const versions = listInstalledVersions(agent);
    if (versions.length === 0) return { error: `${AGENTS[agent].name} has no installed versions. Run \`agents add ${agent}@<version>\` first.` };
    return { agent, versions };
  }

  if (versionPart === 'default') {
    const def = getGlobalDefault(agent);
    if (!def) return { error: `${AGENTS[agent].name} has no default version pinned. Run \`agents use ${agent}@<version>\`.` };
    return { agent, versions: [def] };
  }

  const spec = parseAgentSpec(`${agent}@${versionPart}`);
  if (!spec) return { error: `Invalid version: ${versionPart}` };
  if (!isVersionInstalled(agent, versionPart)) {
    return { error: `${AGENTS[agent].name}@${versionPart} is not installed. Installed: ${listInstalledVersions(agent).join(', ') || '(none)'}` };
  }
  return { agent, versions: [versionPart] };
}

function parseKindFilter(arg: string | undefined): DoctorKind[] | { error: string } {
  if (!arg) return DOCTOR_ALL_KINDS as DoctorKind[];
  const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<DoctorKind>(DOCTOR_ALL_KINDS);
  const out: DoctorKind[] = [];
  for (const k of requested) {
    if (!valid.has(k as DoctorKind)) {
      return { error: `Unknown kind: ${k}. Valid: ${DOCTOR_ALL_KINDS.join(', ')}` };
    }
    out.push(k as DoctorKind);
  }
  return out;
}

function statusLabel(status: ResourceDiff['status']): string {
  switch (status) {
    case 'ok': return chalk.green('ok   ');
    case 'diff': return chalk.yellow('DIFF ');
    case 'missing': return chalk.red('MISS ');
    case 'extra': return chalk.magenta('EXTRA');
  }
}

function sourceLabel(diff: ResourceDiff, layers: VersionResourceReport['layers']): string {
  if (!diff.source) return '';
  if (diff.source === 'extra') {
    // Find which extra repo this came from.
    const sourcePath = diff.sourcePath;
    if (sourcePath) {
      for (const e of layers.extras) {
        if (sourcePath.startsWith(e.dir + '/') || sourcePath === e.dir) {
          return chalk.gray(`source=extra:${e.alias}`);
        }
      }
    }
    return chalk.gray('source=extra');
  }
  return chalk.gray(`source=${diff.source}`);
}

function countByStatus(rows: ResourceDiff[]): { ok: number; diff: number; missing: number; extra: number } {
  let ok = 0, diff = 0, missing = 0, extra = 0;
  for (const r of rows) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'diff') diff++;
    else if (r.status === 'missing') missing++;
    else if (r.status === 'extra') extra++;
  }
  return { ok, diff, missing, extra };
}

function renderKindSection(
  kind: DoctorKind,
  rows: ResourceDiff[],
  layers: VersionResourceReport['layers'],
  options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> },
): void {
  const counts = countByStatus(rows);
  const total = rows.length;
  const summaryParts: string[] = [];
  if (counts.ok) summaryParts.push(`${counts.ok} ok`);
  if (counts.diff) summaryParts.push(chalk.yellow(`${counts.diff} diff`));
  if (counts.missing) summaryParts.push(chalk.red(`${counts.missing} missing`));
  if (counts.extra) summaryParts.push(chalk.magenta(`${counts.extra} extra`));
  const summary = total === 0 ? chalk.gray('(none)') : summaryParts.join(', ');
  console.log(`  ${chalk.bold(kind.padEnd(11))} ${chalk.gray(`${total} item${total === 1 ? '' : 's'}`)}  ${summary}`);

  if (total === 0) return;

  // Hide ok rows by default for big lists; show them only with --diff so the
  // operator can verify presence; otherwise keep output focused on problems.
  const visible = options.showDiff ? rows : rows.filter((r) => r.status !== 'ok');
  if (visible.length === 0) {
    console.log(`    ${chalk.gray('all ok')}`);
    return;
  }

  for (const r of visible) {
    const src = sourceLabel(r, layers);
    const name = padToWidth(truncateToWidth(r.name, 28), 28);
    const prefix = `    ${statusLabel(r.status)}  ${name} ${src}`;
    const detail = r.detail
      ? chalk.gray(`  ${truncateToWidth(collapseWhitespace(r.detail), Math.max(1, terminalWidth() - stringWidth(prefix) - 2))}`)
      : '';
    console.log(prefix + detail);

    if (options.showDiff && r.status === 'diff' && r.sourcePath && r.homePath) {
      const expected = readExpectedForDiff(kind, r);
      const actual = safeRead(r.homePath);
      if (expected != null && actual != null) {
        const patch = unifiedDiff(expected, actual, {
          fromLabel: r.sourcePath,
          toLabel: r.homePath,
          context: 2,
        });
        if (patch) console.log(colorizeUnifiedDiff(patch, '      '));
      }
    }
  }
}

function safeRead(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function readExpectedForDiff(kind: DoctorKind, row: ResourceDiff): string | null {
  // Skills are directories; per-file diffs would need recursive walking.
  // Keep the v1 behaviour minimal: the row already says DIFF, the user can
  // open the source path to inspect.
  if (kind === 'skills') return null;
  if (!row.sourcePath) return null;
  return safeRead(row.sourcePath);
}

function renderTargetText(report: VersionResourceReport, options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> }): void {
  const label = `${AGENT_NAMES[report.agent] || report.agent}@${report.version}`;
  console.log(chalk.bold(label));
  const homePrefix = '  home: ';
  const cwdPrefix = '  cwd:  ';
  console.log(chalk.gray(homePrefix + truncateToWidth(report.home, Math.max(1, terminalWidth() - stringWidth(homePrefix)))));
  console.log(chalk.gray(cwdPrefix + truncateToWidth(report.cwd, Math.max(1, terminalWidth() - stringWidth(cwdPrefix)))));
  const layerStr = [
    report.layers.project ? `project=${report.layers.project}` : null,
    `user=${report.layers.user}`,
    `system=${report.layers.system}`,
    report.layers.extras.length > 0
      ? `extras=[${report.layers.extras.map((e) => e.alias).join(',')}]`
      : null,
  ].filter(Boolean).join(' ');
  printWrappedLine('  layers: ', layerStr);

  // Staleness manifest verdict — single-line summary from the staleness
  // library, sitting alongside the detailed per-resource diff below.
  const manifest = loadManifest(report.agent, report.version);
  if (!manifest) {
    console.log(chalk.gray(`  manifest: ${chalk.gray('cold')} (never synced)`));
  } else {
    const stale = isStale(manifest, report.agent, report.version, report.cwd);
    if (stale) {
      console.log(chalk.gray('  manifest: ') + chalk.yellow('stale') + chalk.gray(' (sources changed since last sync)'));
    } else {
      console.log(chalk.gray('  manifest: ') + chalk.green('fresh'));
    }
  }
  console.log();

  for (const kind of DOCTOR_ALL_KINDS) {
    const rows = report.kinds[kind];
    // Skip kinds that weren't requested (kind filter narrowed the report).
    // We detect this by checking whether the kind has any rows AND was in
    // scope; absent kinds with empty arrays still render so the operator
    // sees what was checked. options.requestedKinds drives this.
    if (options.requestedKinds && !options.requestedKinds.has(kind)) continue;
    renderKindSection(kind, rows, report.layers, options);
  }

  console.log();
  const { ok, diff, missing, extra } = report.summary;
  const verdictParts: string[] = [];
  if (diff) verdictParts.push(chalk.yellow(`${diff} divergent`));
  if (missing) verdictParts.push(chalk.red(`${missing} missing`));
  if (extra) verdictParts.push(chalk.magenta(`${extra} extra`));
  if (verdictParts.length === 0) {
    console.log(chalk.green(`  Verdict: ${ok} resource${ok === 1 ? '' : 's'} reconciled. Version home matches resolved sources.`));
  } else {
    console.log(`  Verdict: ${verdictParts.join(', ')}.`);
    printWrappedLine('  ', `Run \`agents doctor ${report.agent}@${report.version} --fix\` to heal, or \`agents prune cleanup\` to drop extras.`);
  }
}

// ─── fix / heal mode ───────────────────────────────────────────────────────────

function renderHealText(result: HealResult): void {
  for (const r of result.repairedManifests) {
    console.log(`  ${chalk.green('repair')}  plugin ${chalk.bold(r.plugin)} ${chalk.gray(`— dropped invalid ${r.droppedFields.join(', ')} field`)}`);
  }
  for (const r of result.refreshedPlugins) {
    console.log(`  ${chalk.green('refresh')} plugin ${chalk.bold(r.plugin)}  ${chalk.gray(`${r.from} → ${r.to}`)}`);
  }
  for (const s of result.skippedPlugins) {
    const why = s.reason === 'modified'
      ? `locally modified — left as-is (run \`agents plugins update ${s.plugin}\` to force)`
      : `no baseline recorded — left as-is (run \`agents plugins update ${s.plugin}\` to adopt)`;
    console.log(`  ${chalk.yellow('hold  ')} plugin ${chalk.bold(s.plugin)}  ${chalk.gray(`${s.from} → ${s.upstream} available; ${why}`)}`);
  }

  for (const v of result.versions) {
    const label = `${AGENT_NAMES[v.agent] || v.agent}@${v.version}`;
    if (v.healed.length === 0 && v.skipped.length === 0) continue;
    const byKind = new Map<string, number>();
    for (const h of v.healed) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
    const parts = Array.from(byKind, ([k, n]) => `${n} ${k}`);
    if (v.healed.length > 0) {
      console.log(`  ${chalk.green('fixed ')}  ${label}  ${chalk.gray(parts.join(', '))}`);
    }
    const drift = v.skipped.filter((s) => s.reason === 'drift');
    const unres = v.skipped.filter((s) => s.reason === 'unreconcilable');
    if (drift.length > 0) {
      console.log(`  ${chalk.yellow('drift ')}  ${label}  ${chalk.gray(`${drift.length} hand-edited — left as-is (use \`--diff\` to inspect)`)}`);
    }
    if (unres.length > 0) {
      const names = unres.map((s) => `${s.kind}/${s.name}`).join(', ');
      console.log(`  ${chalk.yellow('hold  ')}  ${label}  ${chalk.gray(`${unres.length} couldn't reconcile (${names}) — source/home mismatch the writer can't satisfy`)}`);
    }
  }

  console.log();
  const healed = result.versions.reduce((n, v) => n + v.healed.length, 0);
  const touchedVersions = result.versions.filter((v) => v.healed.length > 0).length;
  if (!healChangedAnything(result)) {
    console.log(chalk.green('✓ Everything in sync — nothing to heal.'));
  } else {
    const bits: string[] = [];
    if (healed > 0) bits.push(`${healed} resource${healed === 1 ? '' : 's'} across ${touchedVersions} version${touchedVersions === 1 ? '' : 's'}`);
    if (result.repairedManifests.length > 0) bits.push(`${result.repairedManifests.length} manifest${result.repairedManifests.length === 1 ? '' : 's'} repaired`);
    if (result.refreshedPlugins.length > 0) bits.push(`${result.refreshedPlugins.length} plugin${result.refreshedPlugins.length === 1 ? '' : 's'} refreshed`);
    console.log(chalk.green(`✓ Healed ${bits.join(', ')}.`));
  }
}

async function runFix(parsed: { agent: AgentId; versions: string[] } | null, opts: DoctorOptions): Promise<void> {
  // Heal targets the global install — project layer is irrelevant, so cwd is
  // left to heal's neutral default rather than process.cwd().
  if (!opts.json) console.log(chalk.bold('Healing…'));
  const result = await heal({
    mode: 'full',
    agent: parsed?.agent,
    versions: parsed?.versions,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  renderHealText(result);
}

// ─── command registration ────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  const doctorCmd = addHostOption(program.command('doctor [target]'))
    .description('Diagnose CLI availability, sync status, and resource divergence (optionally for a specific agent[@version]).')
    .option('--json', 'Output machine-readable JSON')
    .option('--diff', 'In target mode, include unified diffs for divergent files')
    .option('--fix', 'Heal gaps: install missing resources, repair invalid plugin manifests, refresh stale plugins, and reconcile drift (all installed versions, or just the target)')
    .option('--kind <kinds>', 'Restrict to comma-separated resource kinds (commands,skills,hooks,rules,mcp,permissions,subagents,plugins,promptcuts)')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())');

  setHelpSections(doctorCmd, {
    examples: `
      # Overview: CLI availability + sync status + orphans across all defaults
      agents doctor

      # Full per-resource report for the active default
      agents doctor claude@default

      # All installed versions of one agent
      agents doctor gemini

      # Pin to a specific installed version
      agents doctor codex@0.117.0

      # Inspect only rules and hooks, with full diffs
      agents doctor claude@default --kind rules,hooks --diff

      # Heal every gap across all installed versions
      agents doctor --fix

      # Heal just one agent (all its installed versions)
      agents doctor claude --fix
    `,
  });

  doctorCmd.action(async (target: string | undefined, opts: DoctorOptions) => {
      const cwd = opts.cwd ? opts.cwd : process.cwd();

      // --fix turns the read-only diagnosis into a heal. With no target it heals
      // every installed version; with a target it scopes to that agent.
      if (opts.fix) {
        let scope: { agent: AgentId; versions: string[] } | null = null;
        if (target) {
          const parsed = parseTargetArg(target);
          if ('error' in parsed) {
            console.error(chalk.red(parsed.error));
            process.exit(1);
          }
          scope = parsed;
        }
        await runFix(scope, opts);
        return;
      }

      if (!target) {
        const clis = checkAllClis();
        const syncRows = checkSyncStatus(cwd);
        const orphanRows = countOrphans();
        const hostClis = listCliStatus(cwd);
        if (opts.json) {
          console.log(JSON.stringify({
            clis,
            sync: syncRows,
            orphans: orphanRows,
            hostClis: {
              statuses: hostClis.statuses.map((s) => ({
                name: s.manifest.name,
                source: s.manifest.source,
                description: s.manifest.description ?? null,
                installed: s.installed,
              })),
              errors: hostClis.errors,
            },
          }, null, 2));
          return;
        }
        renderOverviewText(clis, syncRows, orphanRows, hostClis);
        // Point at the interactive reconcile when anything is out of sync — the
        // report shouldn't be a dead end. `agents status` runs the unified
        // home-reading engine and offers to sync (opt-in, never auto-fires here).
        if (syncRows.some((r) => r.status !== 'fresh')) {
          console.log(chalk.gray('\nRun `agents status` to review and sync what has drifted.'));
        }
        return;
      }

      const parsed = parseTargetArg(target);
      if ('error' in parsed) {
        console.error(chalk.red(parsed.error));
        process.exit(1);
      }

      const kinds = parseKindFilter(opts.kind);
      if (!Array.isArray(kinds)) {
        console.error(chalk.red(kinds.error));
        process.exit(1);
      }

      const reports: VersionResourceReport[] = parsed.versions.map((v) =>
        diffVersionResources(parsed.agent, v, { cwd, kinds }),
      );

      if (opts.json) {
        console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
        return;
      }

      const showDiff = !!opts.diff;
      const requestedKinds = opts.kind ? new Set(kinds) : undefined;
      reports.forEach((r, i) => {
        if (i > 0) console.log();
        const home = getVersionHomePath(r.agent, r.version);
        if (!fs.existsSync(home)) {
          console.log(chalk.red(`${AGENT_NAMES[r.agent] || r.agent}@${r.version}: version home not found at ${home}`));
          return;
        }
        renderTargetText(r, { showDiff, requestedKinds });
      });
    });
}
