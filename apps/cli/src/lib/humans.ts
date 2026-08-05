/**
 * humans.yaml — owner identity, channels, and notification policy.
 *
 * Canonical file: ~/.agents/humans.yaml
 * Schema version: 1
 *
 * This module is the single read/write seam for humans.yaml. All channel/
 * notify consumers should read owner config from here.
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
 * Return the effective owner notification destination from humans.yaml.
 * The owner's normal-severity policy selects the channel; when no normal
 * policy is declared, the first addressable channel is the default.
 */
export function getOwnerNotifyFromHumans(): { channel: string; to: string } | null {
  const owner = readHumans()?.owner;
  const channels = owner?.channels ?? [];
  const preferredIds = owner?.policy?.normal ?? [];
  const preferred = preferredIds
    .map((id) => channels.find((entry) => entry.id === id))
    .find((entry) => entry?.to);
  const selected = preferred ?? channels.find((entry) => entry.to);
  if (selected?.id && selected.to) return { channel: selected.id, to: selected.to };
  return null;
}

/**
 * Read the owner block from humans.yaml. Returns null if missing.
 */
export function getOwnerFromHumans(): HumanOwner | null {
  return readHumans()?.owner ?? null;
}
