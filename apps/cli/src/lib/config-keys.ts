/**
 * Unified config key grammar for `agents config`.
 *
 * Translates user-facing dotted keys like `run.claude@*.tier.best` into the
 * existing storage locations (run.defaults, model.tiers, config.*,
 * defaultBrowserProfile, deviceConfig.*) so the new command barrel can sit on
 * top of the current YAML schema without a migration.
 */

import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import { MODEL_TIERS, type ModelTier } from './model-tiers.js';
import { VERSION_RE } from './run-defaults.js';

/** The top-level scope of a unified config key. */
export type ConfigScope = 'run' | 'interactive' | 'usage' | 'auto' | 'browser' | 'project' | 'device';

/** A run-time default key: model, mode, effort, or tier override. */
export interface ParsedRunConfigKey {
  scope: 'run';
  agent: AgentId;
  version: string;
  property: 'model' | 'mode' | 'effort' | 'tier';
  tier?: ModelTier;
}

/** The interactive host pin. */
export interface ParsedInteractiveConfigKey {
  scope: 'interactive';
  property: 'host';
}

/** The host whose usage snapshots are authoritative for fleet-wide reporting. */
export interface ParsedUsageConfigKey {
  scope: 'usage';
  property: 'primary-host';
}

/** Which devices automatic placement (`--device auto`) may pick. */
export interface ParsedAutoConfigKey {
  scope: 'auto';
  property: 'pool';
}

/** The default browser profile (device-scope, self or peer). */
export interface ParsedBrowserConfigKey {
  scope: 'browser';
  property: 'profile';
  device?: string;
}

export interface ParsedProjectConfigKey {
  scope: 'project';
  property: 'root';
}

/** A per-device configuration key. */
export interface ParsedDeviceConfigKey {
  scope: 'device';
  device: string;
  property: DeviceConfigProperty;
}

export type ParsedConfigKey =
  | ParsedRunConfigKey
  | ParsedInteractiveConfigKey
  | ParsedUsageConfigKey
  | ParsedAutoConfigKey
  | ParsedBrowserConfigKey
  | ParsedProjectConfigKey
  | ParsedDeviceConfigKey;

export type DeviceConfigProperty =
  | 'role'
  | 'max-agents'
  | 'scheduler'
  | 'daemon'
  | 'watchdog'
  | 'tmux'
  | 'browser.remote-control'
  | 'browser.task-idle-minutes'
  | 'notes'
  | 'browser.profile';

const DEVICE_CONFIG_PROPERTIES: DeviceConfigProperty[] = [
  'role',
  'max-agents',
  'scheduler',
  'daemon',
  'watchdog',
  'tmux',
  'browser.remote-control',
  'browser.task-idle-minutes',
  'notes',
  'browser.profile',
];

/** Split an agent@version token into its parts. Accepts both `@` and `:`. */
function parseAgentVersion(token: string): { agent: AgentId; version: string } {
  const sep = token.includes('@') ? '@' : ':';
  const [agentPart, versionPart = '*'] = token.split(sep);
  const agent = agentPart.toLowerCase();
  if (!(agent in AGENTS)) {
    throw new Error(
      `Unknown agent '${agentPart}'. Known agents: ${Object.keys(AGENTS).join(', ')}.`,
    );
  }
  if (!VERSION_RE.test(versionPart)) {
    throw new Error(
      `Invalid version '${versionPart}' in '${token}'. Use *, latest, or [A-Za-z0-9._+-]{1,64}.`,
    );
  }
  return { agent: agent as AgentId, version: versionPart };
}

/** Normalize agent@version to use `@` consistently. */
export function formatAgentVersion(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

/**
 * Parse a unified config key into its structured representation.
 *
 * Supported forms:
 *   run.<agent@version>.model
 *   run.<agent@version>.mode
 *   run.<agent@version>.effort
 *   run.<agent@version>.tier.<cheap|default|best|ultra>
 *   interactive.host
 *   usage.primary-host
 *   auto.pool
 *   browser.profile
 *   project.root
 *   devices.<name>.role
 *   devices.<name>.max-agents
 *   devices.<name>.scheduler
 *   devices.<name>.daemon
 *   devices.<name>.watchdog
 *   devices.<name>.tmux
 *   devices.<name>.browser.remote-control
 *   devices.<name>.browser.task-idle-minutes
 *   devices.<name>.notes
 *   devices.<name>.browser.profile
 */
export function parseConfigKey(key: string): ParsedConfigKey {
  const raw = key.trim();
  if (!raw) throw new Error('Config key is required.');

  const runMatch = raw.match(/^run\.(.+)\.(model|mode|effort)$/);
  if (runMatch) {
    const { agent, version } = parseAgentVersion(runMatch[1]);
    return { scope: 'run', agent, version, property: runMatch[2] as 'model' | 'mode' | 'effort' };
  }

  const tierMatch = raw.match(/^run\.(.+)\.tier\.(cheap|default|best|ultra)$/i);
  if (tierMatch) {
    const { agent, version } = parseAgentVersion(tierMatch[1]);
    return { scope: 'run', agent, version, property: 'tier', tier: tierMatch[2].toLowerCase() as ModelTier };
  }

  if (raw === 'interactive.host') {
    return { scope: 'interactive', property: 'host' };
  }

  if (raw === 'usage.primary-host') {
    return { scope: 'usage', property: 'primary-host' };
  }

  if (raw === 'auto.pool') {
    return { scope: 'auto', property: 'pool' };
  }

  if (raw === 'browser.profile') {
    return { scope: 'browser', property: 'profile' };
  }

  if (raw === 'project.root') {
    return { scope: 'project', property: 'root' };
  }

  const deviceMatch = raw.match(
    /^devices\.(.+)\.(role|max-agents|scheduler|daemon|watchdog|tmux|notes|browser\.remote-control|browser\.task-idle-minutes|browser\.profile)$/,
  );
  if (deviceMatch) {
    return {
      scope: 'device',
      device: deviceMatch[1],
      property: deviceMatch[2] as DeviceConfigProperty,
    };
  }

  // Provide helpful errors for common mistakes.
  if (raw.startsWith('run.')) {
    throw new Error(
      `Invalid run config key '${key}'. Expected run.<agent@version>.<model|mode|effort> or run.<agent@version>.tier.<cheap|default|best|ultra>.`,
    );
  }
  if (raw.startsWith('interactive.')) {
    throw new Error(`Invalid interactive config key '${key}'. Use interactive.host.`);
  }
  if (raw.startsWith('usage.')) {
    throw new Error(`Invalid usage config key '${key}'. Use usage.primary-host.`);
  }
  if (raw.startsWith('auto.')) {
    throw new Error(`Invalid auto config key '${key}'. Use auto.pool.`);
  }
  if (raw.startsWith('browser.')) {
    throw new Error(`Invalid browser config key '${key}'. Use browser.profile.`);
  }
  if (raw.startsWith('project.')) {
    throw new Error(`Invalid project config key '${key}'. Use project.root.`);
  }
  if (raw.startsWith('devices.')) {
    throw new Error(
      `Invalid device config key '${key}'. Expected devices.<name>.<${DEVICE_CONFIG_PROPERTIES.join('|')}>.`,
    );
  }

  throw new Error(
    `Unknown config scope in '${key}'. Use one of: run, interactive, usage, auto, browser, project, devices.`,
  );
}

/** Render a parsed key back to its canonical dotted string. */
export function formatConfigKey(parsed: ParsedConfigKey): string {
  switch (parsed.scope) {
    case 'run':
      if (parsed.property === 'tier') {
        return `run.${formatAgentVersion(parsed.agent, parsed.version)}.tier.${parsed.tier}`;
      }
      return `run.${formatAgentVersion(parsed.agent, parsed.version)}.${parsed.property}`;
    case 'interactive':
      return 'interactive.host';
    case 'usage':
      return 'usage.primary-host';
    case 'auto':
      return 'auto.pool';
    case 'browser':
      return parsed.device ? `devices.${parsed.device}.browser.profile` : 'browser.profile';
    case 'project':
      return 'project.root';
    case 'device':
      return `devices.${parsed.device}.${parsed.property}`;
  }
}

/** List every canonical key the command documents, with wildcards expanded to a concrete example. */
export function listKnownConfigKeys(): string[] {
  const keys: string[] = [];
  keys.push(
    'run.<agent@version>.model',
    'run.<agent@version>.mode',
    'run.<agent@version>.effort',
  );
  for (const tier of MODEL_TIERS) {
    keys.push(`run.<agent@version>.tier.${tier}`);
  }
  keys.push('interactive.host', 'usage.primary-host', 'auto.pool', 'browser.profile', 'project.root');
  for (const prop of DEVICE_CONFIG_PROPERTIES) {
    keys.push(`devices.<name>.${prop}`);
  }
  return keys;
}

/**
 * Map a parsed device property to the internal device-config key name.
 * This is the bridge between the friendly `agents config` surface and the
 * existing CONFIG_KEYS registry in lib/device-config.ts.
 */
export function devicePropertyToConfigName(property: DeviceConfigProperty): string {
  switch (property) {
    case 'role':
      return 'role';
    case 'max-agents':
      return 'agents.max-concurrent';
    case 'scheduler':
      return 'scheduler.enabled';
    case 'daemon':
      return 'daemon.enabled';
    case 'watchdog':
      return 'watchdog.enabled';
    case 'tmux':
      return 'tmux.enabled';
    case 'browser.remote-control':
      return 'browser.remote-control';
    case 'browser.task-idle-minutes':
      return 'browser.task-idle-minutes';
    case 'notes':
      return 'notes';
    case 'browser.profile':
      return 'browser.profile';
  }
}

/**
 * Map a parsed key to the human-readable "where is this stored" note.
 * Useful for `agents config list --source` output.
 */
export function configKeyStorageHint(parsed: ParsedConfigKey): string {
  switch (parsed.scope) {
    case 'run':
      if (parsed.property === 'tier') {
        return `model.tiers.${parsed.agent}:${parsed.version}.${parsed.tier}`;
      }
      return `run.defaults.${parsed.agent}:${parsed.version}.${parsed.property}`;
    case 'interactive':
      return 'config.interactiveHost';
    case 'usage':
      return 'config.usagePrimaryHost';
    case 'auto':
      return 'config.autoPool';
    case 'browser':
      return parsed.device
        ? `devices/${parsed.device}/agents.yaml config.defaultBrowserProfile`
        : 'devices/<self>/agents.yaml config.defaultBrowserProfile';
    case 'project':
      return 'devices.<self>.projectRoot';
    case 'device':
      return `devices/${parsed.device}/agents.yaml config (${devicePropertyToConfigName(parsed.property)}; fleet default: fleet.defaults.config)`;
  }
}
