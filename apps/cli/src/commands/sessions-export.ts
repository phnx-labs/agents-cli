/**
 * `agents sessions export` — bundle N selected sessions into a portable,
 * self-describing archive (RUSH-1710).
 *
 * The successor to background R2/CRDT sync for the durable-archive / hand-off
 * case: instead of an always-on merge daemon, the user explicitly bundles the
 * sessions they want to carry to an offline box or keep as an archive. The
 * bundle format + placement live in ../lib/session/bundle.ts; this command owns
 * only the SELECTION (which sessions) and the OUTPUT (file or stdout).
 *
 * Selection flags (`--since`, `-n/--limit`, `--all`, `-a/--agent`,
 * `--no-redact`) are inherited from the parent `sessions` command and read via
 * optsWithGlobals(), so they never shadow the parent's parsing; this command
 * adds only the export-specific flags (`-o/--output`, `--stdout`, `--encrypt`).
 *
 * Rendered markdown/json of a single session is already served by
 * `agents sessions <id> --markdown|--json`; export is specifically the portable,
 * re-importable BUNDLE, so it does not re-expose those render formats.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { filterSessionsByQuery, parseAgentFilter } from './sessions.js';
import { listLocalTranscripts, SYNC_AGENTS, type LocalTranscript } from '../lib/session/sync/agents.js';
import { machineId } from '../lib/machine-id.js';
import { getHistoryDir } from '../lib/state.js';
import { loadR2Config } from '../lib/session/sync/config.js';
import { resolveSyncEncKey, generateSyncEncKey } from '../lib/session/sync/transcript-crypto.js';
import {
  buildRecord,
  makeHeader,
  mergeRecords,
  serializeBundle,
  specForAgent,
  type BundleHeader,
  type BundleRecord,
  type FileToExport,
} from '../lib/session/bundle.js';
import { pullBundlesFromHosts } from '../lib/session/remote-bundle.js';
import { setHelpSections } from '../lib/help.js';

/** Default cap when exporting a scope (not explicit ids) and the user gave no -n. */
const DEFAULT_LIMIT = 500;

export function registerSessionsExportCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('export [selectors...]')
    .description('Bundle sessions (by id, query, or the parent selection flags like --since/-a) into a portable archive.')
    .option('-o, --output <path>', 'Write the bundle to this file')
    .option('--stdout', 'Write the bundle to stdout (for piping into `sessions import -`)')
    .option('--encrypt', 'Seal each transcript body with AES-256-GCM before writing');

  setHelpSections(cmd, {
    examples: `# Bundle the last week of sessions to a file
agents sessions export --since 7d -o week.bundle

# Bundle two specific sessions
agents sessions export 4f8a2b1c 9d3e7a55 -o pair.bundle

# Encrypt + pipe straight into another machine over SSH
agents sessions export --since 7d --stdout --encrypt | agents ssh boxB 'agents sessions import - --decrypt <key>'`,
    notes: `Selection uses the same flags as 'agents sessions' (--since, -n/--limit, --all,
-a/--agent, --no-redact). Bundles are self-describing NDJSON: a header line + one
line per transcript file. Secrets are redacted by default. Dir-shaped sessions
(Kimi) carry all their files. Restore with 'agents sessions import'.`,
  });

  cmd.action(async (selectors: string[], _options: unknown, command: Command) => {
    await runExport(selectors, command);
  });
}

interface GlobalSelection {
  since?: string;
  limit?: string;
  all?: boolean;
  agent?: string;
  redact?: boolean;
  encrypt?: boolean;
  output?: string;
  stdout?: boolean;
  host?: string[];
  claude?: boolean; codex?: boolean; kimi?: boolean; grok?: boolean; opencode?: boolean; antigravity?: boolean;
}

async function runExport(selectors: string[], command: Command): Promise<void> {
  const g = command.optsWithGlobals() as GlobalSelection;

  // --host: export sessions that live on remote peer(s) — run export there and
  // stream the bundle back over the existing SSH transport (RUSH-1712).
  if (g.host && g.host.length > 0) {
    await runRemoteExport(g, selectors, command);
    return;
  }

  const explicitLimit = command.parent?.getOptionValueSource?.('limit') === 'cli';
  const limit = explicitLimit ? Math.max(1, parseInt(String(g.limit), 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const agentFilter = parseAgentFilter(resolveAgentShorthand(g));

  // 1. Discover candidate sessions in scope.
  const metas = await discoverSessions({
    all: g.all !== false,
    agent: agentFilter.agent ?? undefined,
    since: g.since,
    limit,
  });

  // 2. Narrow to the selection (ids > query > everything-in-scope).
  const selected = selectSessions(metas, selectors);
  if (selected.length === 0) {
    process.stderr.write(chalk.yellow('No sessions matched the selection.\n'));
    process.exit(1);
  }
  if (!selectors.length && selected.length >= limit) {
    process.stderr.write(chalk.yellow(`Note: capped at ${limit} sessions. Raise -n to bundle more.\n`));
  }

  // 3. Resolve each selected session to its on-disk file(s).
  const index = buildLocalIndex();
  const self = machineId();
  const files: FileToExport[] = [];
  const skippedAgents = new Set<string>();
  for (const meta of selected) {
    const spec = specForAgent(meta.agent);
    if (!spec) { skippedAgents.add(meta.agent); continue; }
    const machine = meta.machine || self;
    const lt = index.get(`${meta.agent}:${meta.id}`);
    if (lt) {
      for (const f of lt.files) {
        files.push({ agent: meta.agent, machine, sessionId: meta.id, relKey: f.relKey, absPath: f.absPath, label: meta.label });
      }
    } else if (meta.filePath && fs.existsSync(meta.filePath)) {
      // Not in the live-home index (e.g. a mirror of another machine): fall back
      // to the single discovered file, deriving its subdir-relative key.
      const relKey = relKeyFromPath(meta.filePath, meta.agent, machine, spec.subdir);
      files.push({ agent: meta.agent, machine, sessionId: meta.id, relKey, absPath: meta.filePath, label: meta.label });
    }
  }
  if (skippedAgents.size > 0) {
    process.stderr.write(chalk.yellow(`Skipped agents with no portable format: ${[...skippedAgents].sort().join(', ')}.\n`));
  }
  if (files.length === 0) {
    process.stderr.write(chalk.red('Selected sessions have no exportable transcript files.\n'));
    process.exit(1);
  }

  // 4. Resolve encryption key (opt-in) + redaction (default on via parent --no-redact).
  const encryptKey = g.encrypt ? resolveExportKey() : null;
  const redact = g.redact !== false;

  // 5. Build records + header.
  const records: BundleRecord[] = [];
  for (const f of files) {
    try {
      records.push(buildRecord(f, { redact, encryptKey }));
    } catch (err) {
      process.stderr.write(chalk.yellow(`Skipped ${f.agent}/${f.sessionId} (${f.relKey}): ${(err as Error).message}\n`));
    }
  }
  if (records.length === 0) {
    process.stderr.write(chalk.red('Nothing to export after reading files.\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: self,
    exportedAt: new Date().toISOString(),
    encrypted: encryptKey !== null,
    redacted: redact,
    records,
  });
  emitBundle(header, records, g);
}

/**
 * --host path: run `agents sessions export …` on each peer over SSH, stream the
 * bundles back, merge (dedup by origin machine) and emit one local bundle.
 * Encryption is not combined with a remote pull (each peer would seal under its
 * own key); the SSH transport already encrypts the stream in transit.
 */
async function runRemoteExport(g: GlobalSelection, selectors: string[], command: Command): Promise<void> {
  if (g.encrypt) {
    process.stderr.write(chalk.yellow('Note: --encrypt is ignored with --host (the SSH stream is already encrypted). Encrypt a local bundle instead.\n'));
  }
  const { bundles, errors } = await pullBundlesFromHosts(g.host!, forwardExportArgs(g, selectors, command));
  for (const e of errors) process.stderr.write(chalk.yellow(`  ${e}\n`));
  const records = mergeRecords(bundles.map(b => b.records));
  if (records.length === 0) {
    process.stderr.write(chalk.red('No sessions pulled from the given host(s).\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: g.host!.join(','),
    exportedAt: new Date().toISOString(),
    encrypted: false,
    redacted: g.redact !== false,
    records,
  });
  emitBundle(header, records, g);
}

/** Reconstruct the export flags to forward to a peer's own `sessions export`. */
function forwardExportArgs(g: GlobalSelection, selectors: string[], command: Command): string[] {
  const args = [...selectors];
  if (g.since) args.push('--since', g.since);
  const agent = resolveAgentShorthand(g);
  if (agent) args.push('-a', agent);
  if (g.all !== false) args.push('--all');
  if (g.redact === false) args.push('--no-redact');
  if (command.parent?.getOptionValueSource?.('limit') === 'cli' && g.limit) args.push('-n', String(g.limit));
  return args;
}

/** Write the assembled bundle to stdout or a file. */
function emitBundle(header: BundleHeader, records: BundleRecord[], g: GlobalSelection): void {
  const wire = serializeBundle(header, records);
  if (g.stdout) {
    process.stdout.write(wire);
    return;
  }
  const outPath = g.output || defaultBundlePath();
  fs.writeFileSync(outPath, wire, 'utf-8');
  process.stderr.write(chalk.green(
    `Exported ${header.sessions} session${header.sessions === 1 ? '' : 's'} ` +
    `(${header.count} file${header.count === 1 ? '' : 's'}${header.encrypted ? ', encrypted' : ''}${header.redacted ? ', redacted' : ''}) ` +
    `→ ${outPath}\n`,
  ));
}

/** Map the parent's agent shorthands (--claude, --codex, …) or -a/--agent to a filter string. */
function resolveAgentShorthand(g: GlobalSelection): string | undefined {
  if (g.agent) return g.agent;
  if (g.claude) return 'claude';
  if (g.codex) return 'codex';
  if (g.kimi) return 'kimi';
  if (g.grok) return 'grok';
  if (g.opencode) return 'opencode';
  if (g.antigravity) return 'antigravity';
  return undefined;
}

/** ids > query > everything-in-scope. */
function selectSessions(metas: SessionMeta[], selectors: string[]): SessionMeta[] {
  if (selectors.length === 0) return metas;

  const byId: SessionMeta[] = [];
  const unmatched: string[] = [];
  for (const sel of selectors) {
    const hits = resolveSessionById(metas, sel);
    if (hits.length > 0) byId.push(...hits);
    else unmatched.push(sel);
  }
  if (byId.length > 0 && unmatched.length === 0) {
    const seen = new Set<string>();
    return byId.filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }
  // Any selector that isn't an id → treat the whole thing as a text query.
  return filterSessionsByQuery(metas, selectors.join(' '));
}

/** Build `${agent}:${sessionId}` → LocalTranscript across every sync agent (live home only). */
function buildLocalIndex(): Map<string, LocalTranscript> {
  const index = new Map<string, LocalTranscript>();
  for (const spec of SYNC_AGENTS) {
    for (const lt of listLocalTranscripts(spec)) {
      index.set(`${spec.id}:${lt.sessionId}`, lt);
    }
  }
  return index;
}

/** Derive the subdir-relative key for a mirror file path, else fall back to the basename. */
function relKeyFromPath(filePath: string, agent: string, machine: string, subdir: string): string {
  const prefix = path.join(getHistoryDir(), 'backups', agent, machine, subdir) + path.sep;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return path.basename(filePath);
}

/**
 * Resolve the AES key for --encrypt: prefer the fleet-shared R2_SYNC_ENC_KEY (so
 * any machine on the sync bundle can decrypt), else mint an ephemeral key and
 * print it once — it is NOT stored in the bundle.
 */
function resolveExportKey(): Buffer {
  try {
    const key = resolveSyncEncKey(loadR2Config());
    if (key) return key;
  } catch {
    // sync bundle not configured — fall through to an ephemeral key
  }
  const b64 = generateSyncEncKey();
  process.stderr.write(chalk.yellow(
    `Bundle encrypted with a fresh key (not in the bundle). Decrypt with:\n` +
    `  agents sessions import <bundle> --decrypt ${b64}\n`,
  ));
  return Buffer.from(b64, 'base64');
}

/** Default output file when neither -o nor --stdout is given. */
function defaultBundlePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return path.join(process.cwd(), `agents-sessions-${stamp}.bundle`);
}
