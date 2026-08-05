/**
 * humans.yaml — owner identity, channels, and notification policy.
 *
 * Canonical file: ~/.agents/humans.yaml
 * Schema version: 1
 *
 * This module is the single read/write seam for humans.yaml. All channel/
 * notify consumers should read owner config from here (with a fallback to
 * the legacy notify.owner in agents.yaml during the migration window).
 */
import * as fs from 'fs';
import * as yaml from 'yaml';
import type { HumansConfig, HumanOwner } from './types.js';
import { getHumansFilePath } from './state.js';

export const HUMANS_VERSION = 1 as const;

export const HUMANS_HEADER = `# humans.yaml — owner identity and notification channels
# Managed by agents-cli. See: agents humans --help
`;

/**
 * Read and parse humans.yaml. Returns null when the file does not exist or
 * is not a valid v1 config — never throws.
 */
export function readHumans(): HumansConfig | null {
  const filePath = getHumansFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const doc = parsed as Record<string, unknown>;
    if (doc['version'] !== HUMANS_VERSION) return null;
    return doc as unknown as HumansConfig;
  } catch {
    return null;
  }
}

/**
 * Write a HumansConfig to ~/.agents/humans.yaml. Creates the file with the
 * canonical header. Overwrites any existing content.
 */
export function writeHumans(config: HumansConfig): void {
  const filePath = getHumansFilePath();
  const body = yaml.stringify(config, { lineWidth: 120 });
  fs.writeFileSync(filePath, HUMANS_HEADER + body, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Return the effective owner notification config from humans.yaml if
 * available, otherwise return null (caller falls back to agents.yaml).
 */
export function getOwnerNotifyFromHumans(): { channel: string; to: string } | null {
  const humans = readHumans();
  const notify = humans?.owner?.notify;
  if (notify?.channel && notify?.to) return notify;
  return null;
}

/**
 * Read the owner block from humans.yaml. Returns null if missing.
 */
export function getOwnerFromHumans(): HumanOwner | null {
  return readHumans()?.owner ?? null;
}
