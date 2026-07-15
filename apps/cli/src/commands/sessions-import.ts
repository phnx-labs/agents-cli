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
  type ImportPlanItem,
  type ParsedBundle,
} from '../lib/session/bundle.js';
import { setHelpSections } from '../lib/help.js';

interface ImportOptions {
  dryRun?: boolean;
  overwrite?: boolean;
  decrypt?: string | boolean; // commander: true when --decrypt bare, string when --decrypt <key>
  agent?: string; // read from the parent `sessions` command via optsWithGlobals
}

export function registerSessionsImportCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('import <bundle>')
    .description('Restore an export bundle (file, or - for stdin) into the local session store, deduping against what you already have.')
    .option('--dry-run', 'Show what would be placed without writing anything')
    .option('--overwrite', 'Replace local files that differ from the bundle (default: keep local)')
    .option('--decrypt [key]', 'Decrypt an encrypted bundle (key optional if the r2.backups sync key is configured)');

  setHelpSections(cmd, {
    examples: `# Preview what a bundle would restore
agents sessions import week.bundle --dry-run

# Restore it
agents sessions import week.bundle

# Pull straight off another machine over SSH
agents ssh boxB 'agents sessions export --since 7d --stdout' | agents sessions import -`,
    notes: `Sessions land under the cross-machine mirror keyed by their origin machine, so
they show up in 'agents sessions' tagged with that machine and never overwrite
your own local sessions. Byte-exact duplicates are skipped.`,
  });

  cmd.action(async (bundlePath: string, options: ImportOptions, command: Command) => {
    const agent = (command.optsWithGlobals() as { agent?: string }).agent;
    await runImport(bundlePath, { ...options, agent });
  });
}

async function runImport(bundlePath: string, options: ImportOptions): Promise<void> {
  // 1. Read the bundle (stdin or file).
  let text: string;
  try {
    text = bundlePath === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(bundlePath, 'utf-8');
  } catch (err) {
    process.stderr.write(chalk.red(`Cannot read bundle: ${(err as Error).message}\n`));
    process.exit(1);
  }

  let bundle: ParsedBundle;
  try {
    bundle = parseBundle(text);
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(1);
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
