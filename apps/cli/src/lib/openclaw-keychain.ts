import { execFileSync } from 'child_process';
import { getCliLaunch } from './cli-entry.js';

export const OPENCLAW_KEYCHAIN_ACCOUNT = 'openclaw';
export const OPENCLAW_KEYCHAIN_PROVIDER = 'agents_keychain';

export const OPENCLAW_KEYCHAIN_ENV_SERVICES: Record<string, string> = {
  OPENROUTER_API_KEY: 'openrouter-api-key',
  LINEAR_API_KEY: 'linear-api-key',
  GRAFANA_API_KEY: 'grafana-api-key',
  POSTHOG_API_KEY: 'posthog-api-key',
};

export interface OpenClawSecretRef {
  source: 'exec';
  provider: string;
  id: string;
}

export interface OpenClawKeychainMigrationOptions {
  account?: string;
  provider?: string;
  agentsBin?: string;
}

export interface OpenClawKeychainMigrationResult {
  services: Array<{ envKey: string; service: string; value: string }>;
  replacedPaths: string[];
  removedEnvPaths: string[];
  unsupportedEnvKeys: string[];
  changed: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretRef(provider: string, service: string): OpenClawSecretRef {
  return { source: 'exec', provider, id: service };
}

function openClawPath(parts: string[]): string {
  return parts.join('.');
}

function collectOpenClawEnv(config: JsonObject): Map<string, { path: string[]; value: string }> {
  const env = isRecord(config.env) ? config.env : null;
  const out = new Map<string, { path: string[]; value: string }>();
  if (!env) return out;

  for (const [key, service] of Object.entries(OPENCLAW_KEYCHAIN_ENV_SERVICES)) {
    void service;
    const top = env[key];
    if (typeof top === 'string' && top.trim()) {
      out.set(key, { path: ['env', key], value: top });
      continue;
    }
    const vars = isRecord(env.vars) ? env.vars : null;
    const nested = vars?.[key];
    if (typeof nested === 'string' && nested.trim()) {
      out.set(key, { path: ['env', 'vars', key], value: nested });
    }
  }
  return out;
}

function deletePath(config: JsonObject, parts: string[]): boolean {
  let current: unknown = config;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current)) return false;
    current = current[part];
  }
  if (!isRecord(current)) return false;
  const key = parts[parts.length - 1];
  if (!(key in current)) return false;
  delete current[key];
  return true;
}

function normalizeObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function ensureOpenClawKeychainProvider(
  config: JsonObject,
  opts: Required<Pick<OpenClawKeychainMigrationOptions, 'account' | 'provider'>>,
  agentsBin?: string,
): void {
  const launch = getCliLaunch(['secrets', 'openclaw-keychain', 'resolve', '--account', opts.account], agentsBin);
  const secrets = normalizeObject(config.secrets);
  const providers = normalizeObject(secrets.providers);
  providers[opts.provider] = {
    source: 'exec',
    command: launch.command,
    args: launch.args,
    jsonOnly: true,
  };
  secrets.providers = providers;
  config.secrets = secrets;
}

function providerEnvKeyForPath(parts: string[]): string | null {
  if (
    parts.length === 8 &&
    parts[0] === 'plugins' &&
    parts[1] === 'entries' &&
    parts[3] === 'config' &&
    parts[4] === 'mcpServers' &&
    parts[6] === 'env'
  ) {
    return parts[7];
  }
  return null;
}

function serviceForSupportedPath(parts: string[], envByValue: Map<string, string>): string | null {
  const envKey = providerEnvKeyForPath(parts);
  if (envKey) return OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey] ?? null;

  if (parts.length === 4 && parts[0] === 'models' && parts[1] === 'providers' && parts[3] === 'apiKey') {
    if (parts[2] === 'openrouter') return OPENCLAW_KEYCHAIN_ENV_SERVICES.OPENROUTER_API_KEY;
  }

  return null;
}

function canReplaceByValue(parts: string[]): boolean {
  if (parts.length === 4 && parts[0] === 'models' && parts[1] === 'providers' && parts[3] === 'apiKey') return true;
  if (parts.length === 6 && parts[0] === 'plugins' && parts[1] === 'entries' && parts[3] === 'config' && parts[4] === 'webSearch' && parts[5] === 'apiKey') return true;
  if (parts.length === 5 && parts[0] === 'tools' && parts[1] === 'web' && parts[2] === 'search' && parts[4] === 'apiKey') return true;
  if (parts.length === 4 && parts[0] === 'tools' && parts[1] === 'web' && parts[2] === 'search' && parts[3] === 'apiKey') return true;
  return providerEnvKeyForPath(parts) !== null;
}

function replaceSupportedSecrets(
  current: unknown,
  parts: string[],
  provider: string,
  envByValue: Map<string, string>,
  services: Map<string, { envKey: string; service: string; value: string }>,
  replacedPaths: string[],
): void {
  if (!isRecord(current) && !Array.isArray(current)) return;
  const entries = Array.isArray(current)
    ? current.map((value, index) => [String(index), value] as const)
    : Object.entries(current);

  for (const [key, value] of entries) {
    const childParts = [...parts, key];
    if (typeof value === 'string' && value.trim() && canReplaceByValue(childParts)) {
      const directService = serviceForSupportedPath(childParts, envByValue);
      const matchedService = directService ?? envByValue.get(value);
      if (matchedService) {
        const envKey = Object.entries(OPENCLAW_KEYCHAIN_ENV_SERVICES).find(([, service]) => service === matchedService)?.[0] ?? matchedService;
        services.set(matchedService, { envKey, service: matchedService, value });
        (current as Record<string, unknown>)[key] = secretRef(provider, matchedService);
        replacedPaths.push(openClawPath(childParts));
        continue;
      }
    }
    replaceSupportedSecrets(value, childParts, provider, envByValue, services, replacedPaths);
  }
}

export function migrateOpenClawConfigToKeychainRefs(
  config: JsonObject,
  opts: OpenClawKeychainMigrationOptions = {},
): OpenClawKeychainMigrationResult {
  const account = opts.account ?? OPENCLAW_KEYCHAIN_ACCOUNT;
  const provider = opts.provider ?? OPENCLAW_KEYCHAIN_PROVIDER;
  const env = collectOpenClawEnv(config);
  const envByValue = new Map<string, string>();
  for (const [envKey, entry] of env) {
    envByValue.set(entry.value, OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey]);
  }

  const services = new Map<string, { envKey: string; service: string; value: string }>();
  const replacedPaths: string[] = [];
  replaceSupportedSecrets(config, [], provider, envByValue, services, replacedPaths);

  const removedEnvPaths: string[] = [];
  const unsupportedEnvKeys: string[] = [];
  for (const [envKey, entry] of env) {
    const service = OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey];
    const wasMapped = [...services.values()].some((s) => s.service === service);
    if (!wasMapped) {
      unsupportedEnvKeys.push(envKey);
      continue;
    }
    services.set(service, { envKey, service, value: entry.value });
    if (deletePath(config, entry.path)) removedEnvPaths.push(openClawPath(entry.path));
  }

  if (services.size > 0) {
    ensureOpenClawKeychainProvider(config, { account, provider }, opts.agentsBin);
  }

  return {
    services: [...services.values()],
    replacedPaths,
    removedEnvPaths,
    unsupportedEnvKeys,
    changed: services.size > 0 || replacedPaths.length > 0 || removedEnvPaths.length > 0,
  };
}

export function storeOpenClawKeychainServices(
  services: Array<{ service: string; value: string }>,
  account = OPENCLAW_KEYCHAIN_ACCOUNT,
): void {
  if (process.platform !== 'darwin') {
    throw new Error('OpenClaw Keychain migration must run on macOS.');
  }
  for (const { service, value } of services) {
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], {
      stdio: 'ignore',
    });
  }
}

function stripSecurityTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

export function readOpenClawKeychainService(service: string, account = OPENCLAW_KEYCHAIN_ACCOUNT): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(service)) {
    throw new Error(`Invalid OpenClaw Keychain service id '${service}'.`);
  }
  if (process.platform !== 'darwin') {
    throw new Error('OpenClaw Keychain resolver must run on macOS.');
  }
  const value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stripSecurityTrailingNewline(value);
}

export interface OpenClawExecResolverRequest {
  protocolVersion?: number;
  provider?: string;
  ids?: unknown;
}

export interface OpenClawExecResolverResponse {
  protocolVersion: 1;
  values: Record<string, string>;
  errors?: Record<string, { code: string }>;
}

export function resolveOpenClawKeychainRequest(
  request: OpenClawExecResolverRequest,
  lookup: (service: string) => string,
): OpenClawExecResolverResponse {
  const ids = Array.isArray(request.ids) ? request.ids.filter((id): id is string => typeof id === 'string') : [];
  const values: Record<string, string> = {};
  const errors: Record<string, { code: string }> = {};
  for (const id of ids) {
    try {
      values[id] = lookup(id);
    } catch {
      errors[id] = { code: 'NOT_FOUND' };
    }
  }
  return {
    protocolVersion: 1,
    values,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
