/**
 * `agents sessions import <bundle|->` — restore an export bundle (RUSH-1711).
 *
 * The inverse of `sessions export`: read a bundle (file or stdin), validate it,
 * and place each transcript where the cross-machine sync would — a mirror keyed
 * by the session's ORIGIN machine (see bundle.ts / mirrorPath). Placement dedups
 * byte-exact against what is already on disk and never clobbers this machine's
 * own live sessions ("local always wins" falls out of the scanner's
 * live-home-first dedup), so a re-import or an overlapping bundle is safe.
 */
import * as fs from 'fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadR2Config } from '../lib/session/sync/config.js';
import { resolveSyncEncKey } from '../lib/session/sync/transcript-crypto.js';
import {
  parseBundle,
  planImport,
  writeImport,
  mergeRecords,
  makeHeader,
  type ImportPlanItem,
  type ParsedBundle,
} from '../lib/session/bundle.js';
import { pullBundlesFromHosts } from '../lib/session/remote-bundle.js';
import { setHelpSections } from '../lib/help.js';

interface ImportOptions {
  dryRun?: boolean;
  overwrite?: boolean;
  decrypt?: string | boolean; // commander: true when --decrypt bare, string when --decrypt <key>
  fromHost?: string[];
  agent?: string; // read from the parent `sessions` command via optsWithGlobals
}

export function registerSessionsImportCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('import [bundle]')
    .description('Restore an export bundle (file, - for stdin, or --from-host <h>) into the local session store, deduping against what you already have.')
    .option('--dry-run', 'Show what would be placed without writing anything')
    .option('--overwrite', 'Replace local files that differ from the bundle (default: keep local)')
    .option('--decrypt [key]', 'Decrypt an encrypted bundle (key optional if the r2.backups sync key is configured)')
    .option('--from-host <target...>', 'Pull sessions live from remote peer(s) over SSH instead of a file (repeatable)');

  setHelpSections(cmd, {
    examples: `# Preview what a bundle would restore
agents sessions import week.bundle --dry-run

# Restore it
agents sessions import week.bundle

# Pull straight off another machine (one command, over SSH)
agents sessions import --from-host yosemite-s1 --since 7d

# Or the equivalent raw pipe
agents ssh boxB 'agents sessions export --since 7d --stdout' | agents sessions import -`,
    notes: `Sessions land under the cross-machine mirror keyed by their origin machine, so
they show up in 'agents sessions' tagged with that machine and never overwrite
your own local sessions. Byte-exact duplicates are skipped. --from-host reuses
the same SSH transport as the cross-machine listing (no R2, no daemon).`,
  });

  cmd.action(async (bundlePath: string | undefined, options: ImportOptions, command: Command) => {
    const g = command.optsWithGlobals() as { agent?: string; since?: string; all?: boolean; limit?: string };
    await runImport(bundlePath, { ...options, agent: g.agent }, g, command);
  });
}

async function runImport(
  bundlePath: string | undefined,
  options: ImportOptions,
  g: { since?: string; all?: boolean; limit?: string },
  command: Command,
): Promise<void> {
  // 1. Obtain the bundle — from remote peer(s), stdin, or a file.
  let bundle: ParsedBundle;
  if (options.fromHost && options.fromHost.length > 0) {
    bundle = await pullForImport(options.fromHost, bundlePath, g, command);
  } else {
    if (!bundlePath) {
      process.stderr.write(chalk.red('Provide a bundle path, - for stdin, or --from-host <host>.\n'));
      process.exit(1);
    }
    let text: string;
    try {
      text = bundlePath === '-' ? await readStdin() : fs.readFileSync(bundlePath, 'utf-8');
    } catch (err) {
      process.stderr.write(chalk.red(`Cannot read bundle: ${(err as Error).message}\n`));
      process.exit(1);
    }
    try {
      bundle = parseBundle(text);
    } catch (err) {
      process.stderr.write(chalk.red(`${(err as Error).message}\n`));
      process.exit(1);
    }
  }

  // 2. Optional agent filter.
  if (options.agent) {
    bundle = { header: bundle.header, records: bundle.records.filter(r => r.agent === options.agent) };
    if (bundle.records.length === 0) {
      process.stderr.write(chalk.yellow(`No records for agent '${options.agent}' in this bundle.\n`));
      process.exit(1);
    }
  }

  // 3. Resolve the decryption key if the bundle is encrypted.
  const decryptKey = bundle.header.encrypted ? resolveDecryptKey(options.decrypt) : null;

  // 4. Plan.
  let plan: ImportPlanItem[];
  try {
    plan = planImport(bundle, { decryptKey });
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(1);
  }

  if (options.dryRun) {
    printDryRun(plan, bundle);
    return;
  }

  // 5. Write.
  const res = writeImport(plan, { overwrite: options.overwrite === true, decryptKey });
  const parts: string[] = [];
  if (res.placed) parts.push(`${res.placed} placed`);
  if (res.overwritten) parts.push(`${res.overwritten} overwritten`);
  if (res.skipped) parts.push(`${res.skipped} duplicate${res.skipped === 1 ? '' : 's'} skipped`);
  if (res.conflicts) parts.push(chalk.yellow(`${res.conflicts} conflict${res.conflicts === 1 ? '' : 's'} kept local (use --overwrite)`));
  if (res.unknown) parts.push(chalk.yellow(`${res.unknown} unknown-agent skipped`));
  process.stderr.write(chalk.green(`Imported: ${parts.join(', ') || 'nothing to do'}.\n`));
}

/** Drain all of stdin to a string. Works for pipes (non-seekable) and redirects
 *  alike — unlike readFileSync(0), which fails on a pipe. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * --from-host: run `agents sessions export …` on each peer over SSH and merge
 * the streamed bundles into one for import. The optional positional acts as a
 * remote selector (id/query); the parent selection flags (--since, -a, --all,
 * -n) forward too.
 */
async function pullForImport(
  hosts: string[],
  selector: string | undefined,
  g: { since?: string; all?: boolean; limit?: string },
  command: Command,
): Promise<ParsedBundle> {
  const args: string[] = [];
  if (selector && selector !== '-') args.push(selector);
  if (g.since) args.push('--since', g.since);
  const agent = (command.optsWithGlobals() as { agent?: string }).agent;
  if (agent) args.push('-a', agent);
  if (g.all !== false) args.push('--all');
  if (command.parent?.getOptionValueSource?.('limit') === 'cli' && g.limit) args.push('-n', String(g.limit));

  const { bundles, errors } = await pullBundlesFromHosts(hosts, args);
  for (const e of errors) process.stderr.write(chalk.yellow(`  ${e}\n`));
  const records = mergeRecords(bundles.map(b => b.records));
  if (records.length === 0) {
    process.stderr.write(chalk.red('No sessions pulled from the given host(s).\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: hosts.join(','),
    exportedAt: new Date().toISOString(),
    encrypted: false,
    redacted: bundles.some(b => b.header.redacted),
    records,
  });
  return { header, records };
}

/**
 * Decrypt-key resolution: an explicit `--decrypt <key>` (base64 or hex) wins;
 * otherwise fall back to the fleet-shared R2_SYNC_ENC_KEY from the r2.backups
 * bundle. Fails loudly when an encrypted bundle has no usable key.
 */
function resolveDecryptKey(decrypt: string | boolean | undefined): Buffer {
  if (typeof decrypt === 'string' && decrypt.trim()) {
    const raw = decrypt.trim();
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      process.stderr.write(chalk.red(`--decrypt key must decode to 32 bytes (got ${key.length}).\n`));
      process.exit(1);
    }
    return key;
  }
  try {
    const key = resolveSyncEncKey(loadR2Config());
    if (key) return key;
  } catch {
    // sync bundle not configured
  }
  process.stderr.write(chalk.red(
    'This bundle is encrypted but no key is available. Pass --decrypt <key>, ' +
    'or configure the r2.backups sync bundle so its shared key is used.\n',
  ));
  process.exit(1);
}

/** Print the dry-run table, grouped by session. Reads disk, writes nothing. */
function printDryRun(plan: ImportPlanItem[], bundle: ParsedBundle): void {
  // Group file-level plan items by session for a readable table.
  const bySession = new Map<string, { agent: string; machine: string; sessionId: string; statuses: Set<string>; files: number }>();
  for (const item of plan) {
    const key = `${item.record.agent}:${item.record.machine}:${item.record.sessionId}`;
    let row = bySession.get(key);
    if (!row) bySession.set(key, (row = { agent: item.record.agent, machine: item.record.machine, sessionId: item.record.sessionId, statuses: new Set(), files: 0 }));
    row.statuses.add(item.status);
    row.files++;
  }

  process.stdout.write(chalk.bold(`Bundle: ${bundle.header.sessions} session(s), ${bundle.header.count} file(s), origin ${bundle.header.origin}${bundle.header.encrypted ? ', encrypted' : ''}\n\n`));
  const header = `${pad('SESSION', 22)}${pad('AGENT', 10)}${pad('ORIGIN', 16)}${pad('FILES', 7)}STATUS`;
  process.stdout.write(chalk.dim(header) + '\n');
  for (const row of bySession.values()) {
    const status = aggregateStatus(row.statuses);
    process.stdout.write(
      pad(row.sessionId.slice(0, 20), 22) +
      pad(row.agent, 10) +
      pad(row.machine, 16) +
      pad(String(row.files), 7) +
      colorStatus(status) + '\n',
    );
  }
  process.stdout.write(chalk.dim('\n(dry run — nothing was written)\n'));
}

function aggregateStatus(statuses: Set<string>): string {
  if (statuses.has('conflict')) return 'conflict';
  if (statuses.has('unknown')) return 'unknown';
  if (statuses.has('new')) return statuses.has('dup') ? 'partial' : 'new';
  return 'dup';
}

function colorStatus(status: string): string {
  switch (status) {
    case 'new': return chalk.green(status);
    case 'dup': return chalk.dim(status);
    case 'partial': return chalk.cyan(status);
    case 'conflict': return chalk.yellow(status);
    case 'unknown': return chalk.red(status);
    default: return status;
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + ' ' : s + ' '.repeat(w - s.length);
}
