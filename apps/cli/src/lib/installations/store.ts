import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { getVersionsDir } from '../state.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import type { AgentId } from '../types.js';
import { INSTALLATION_RECORD_FILE, INSTALLATION_SCHEMA, type Installation } from './types.js';

/**
 * Persistence for {@link Installation} records.
 *
 * The record lives at `<versionDir>/installation.json` rather than in one
 * central index: the version dir is what `agents trash`/`agents prune` move,
 * copy and restore wholesale, so keeping identity inside it means identity
 * travels with the install instead of dangling in a registry that forgets to
 * follow. It is also why the file name is registered in versions.ts's
 * `PRESERVED_ON_CLEAN_REINSTALL` — a repair reinstall must not mint a new id.
 *
 * Deliberately depends on nothing but `state`/`fs-atomic`/`primitives` so
 * versions.ts can import it without an import cycle.
 */

/** Directory holding one installation. Mirrors versions.ts `getVersionDir`. */
export function installationDir(agent: AgentId, label: string): string {
  return path.join(getVersionsDir(), agent, label);
}

export function installationRecordPath(agent: AgentId, label: string): string {
  return path.join(installationDir(agent, label), INSTALLATION_RECORD_FILE);
}

/** Mint an opaque installation id. Random, never derived from the release. */
export function mintInstallationId(): string {
  return `ins_${crypto.randomBytes(12).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertValidRecord(value: unknown, file: string): Installation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Installation record corrupted at ${file}: expected a JSON object.`);
  }
  const record = value as Partial<Installation>;
  if (typeof record.schema !== 'number') {
    throw new Error(`Installation record corrupted at ${file}: missing numeric "schema".`);
  }
  if (record.schema > INSTALLATION_SCHEMA) {
    throw new Error(
      `Installation record at ${file} was written by a newer agents-cli (schema ${record.schema} > ${INSTALLATION_SCHEMA}). Upgrade agents-cli.`
    );
  }
  for (const key of ['id', 'agent', 'label', 'releaseVersion', 'createdAt', 'updatedAt'] as const) {
    if (typeof record[key] !== 'string' || !record[key]) {
      throw new Error(`Installation record corrupted at ${file}: missing string "${key}".`);
    }
  }
  if (!Array.isArray(record.history) || record.history.length === 0) {
    throw new Error(`Installation record corrupted at ${file}: "history" must be a non-empty array.`);
  }
  return record as Installation;
}

/**
 * Read the record for one installation, or null when the version dir has none.
 * Never mints — use {@link ensureInstallation} for the migrating read.
 */
export function readInstallation(agent: AgentId, label: string): Installation | null {
  const file = installationRecordPath(agent, label);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Installation record corrupted at ${file}: not valid JSON.`);
  }
  return assertValidRecord(parsed, file);
}

export function writeInstallation(installation: Installation): void {
  const file = installationRecordPath(installation.agent, installation.label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(installation, null, 2)}\n`);
}

/**
 * Read the record for an existing version dir, minting and persisting one on
 * first sight. This is the migration path for every installation created before
 * frozen identity existed: their directory name IS their release, so the
 * migrated record seeds `label === releaseVersion` and dates the install from
 * the directory's own mtime rather than pretending it was created now.
 *
 * Throws when the version dir does not exist — an installation record must never
 * describe an install that isn't there.
 */
export function ensureInstallation(agent: AgentId, label: string): Installation {
  const existing = readInstallation(agent, label);
  if (existing) return existing;

  const dir = installationDir(agent, label);
  if (!fs.existsSync(dir)) {
    throw new Error(`No installation directory for ${agent}@${label} at ${dir}.`);
  }
  let createdAt: string;
  try {
    createdAt = fs.statSync(dir).mtime.toISOString();
  } catch {
    createdAt = nowIso();
  }
  const migrated: Installation = {
    schema: INSTALLATION_SCHEMA,
    id: mintInstallationId(),
    agent,
    label,
    releaseVersion: label,
    createdAt,
    updatedAt: createdAt,
    history: [{ releaseVersion: label, at: createdAt }],
  };
  writeInstallation(migrated);
  return migrated;
}

/**
 * Create the record for a freshly-installed version dir. Idempotent: a repeat
 * `agents add` of the same label keeps the original id (identity is frozen) and
 * only records the release if it actually moved.
 */
export function createInstallation(agent: AgentId, label: string, releaseVersion: string): Installation {
  if (!VERSION_RE.test(label)) {
    throw new Error(`Invalid installation label: ${JSON.stringify(label)}`);
  }
  const existing = readInstallation(agent, label);
  if (existing) {
    return existing.releaseVersion === releaseVersion
      ? existing
      : recordRelease(existing, releaseVersion);
  }
  const at = nowIso();
  const created: Installation = {
    schema: INSTALLATION_SCHEMA,
    id: mintInstallationId(),
    agent,
    label,
    releaseVersion,
    createdAt: at,
    updatedAt: at,
    history: [{ releaseVersion, at }],
  };
  writeInstallation(created);
  return created;
}

/**
 * Move an installation's recorded release forward, preserving identity. Returns
 * the persisted record. Call only AFTER the new release is live on disk — the
 * record is the claim that it is.
 */
export function recordRelease(installation: Installation, releaseVersion: string): Installation {
  const at = nowIso();
  const next: Installation = {
    ...installation,
    releaseVersion,
    updatedAt: at,
    history: [...installation.history, { releaseVersion, at }],
  };
  writeInstallation(next);
  return next;
}

/** Version-dir basenames present for an agent, oldest-first by directory name. */
export function listInstallationLabels(agent: AgentId): string[] {
  const agentDir = path.join(getVersionsDir(), agent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every installation of an agent, migrating records as needed. A version dir
 * that disappears mid-scan is skipped rather than failing the whole listing.
 */
export function listInstallations(agent: AgentId): Installation[] {
  const out: Installation[] = [];
  for (const label of listInstallationLabels(agent)) {
    try {
      out.push(ensureInstallation(agent, label));
    } catch {
      /* dir vanished or unreadable — not an installation we can act on */
    }
  }
  return out;
}
