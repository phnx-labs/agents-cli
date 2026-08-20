import type { AgentId } from './types.js';

/**
 * How safely agents-cli can read a harness's native login identity, and at what
 * granularity that identity is scoped.
 *
 * - `inspection`: `strong` = a stable account key (Claude/Codex/Grok);
 *   `email` = only an email claim, so the name binds to an address not a token
 *   (Muse); `opaque` = a stable but non-human identifier from an OAuth/JWT blob
 *   with no email (the device-scoped harnesses); `none` = no inspectable identity.
 * - `scope`: `version` = auth lives per installed version home; `device` = one
 *   login per device shared by every install; `unsupported` = agents-cli must not
 *   name/attach this harness's native login.
 * - `status`: `supported` = name + attach safely; `conditional` = supported only
 *   when the weaker (email) identity is present; `discovery-only` = shown in the
 *   list but not nameable; `unsupported` = neither.
 */
export interface NativeAccountCapability {
  inspection: 'strong' | 'email' | 'opaque' | 'none';
  scope: 'version' | 'device' | 'unsupported';
  status: 'supported' | 'conditional' | 'discovery-only' | 'unsupported';
}

/** Canonical truth for native-account naming and attachment semantics. */
export const NATIVE_ACCOUNT_CAPABILITIES: Record<AgentId, NativeAccountCapability> = {
  // Version-scoped with a strong account key — the only harnesses whose native
  // identity is safe to pin per installed version.
  claude: { inspection: 'strong', scope: 'version', status: 'supported' },
  codex: { inspection: 'strong', scope: 'version', status: 'supported' },
  grok: { inspection: 'strong', scope: 'version', status: 'supported' },
  // Version-scoped but only an email identity — nameable only when that email is
  // present (the resolver rejects an emailless Muse login).
  muse: { inspection: 'email', scope: 'version', status: 'conditional' },
  // Device-scoped, opaque identity (an OAuth/JWT blob). These are recorded as
  // device-scoped opaque, but marked UNSUPPORTED for naming: a NativeAccount has
  // no device-id discriminator, so an opaque/singleton identity cannot be proven
  // to distinguish accounts across synced metadata — Droid exposes no account key
  // at all, and Antigravity (singleton) / OpenCode (provider-set) can read two
  // different credentials as the same identity on another device. A truthful
  // "unsupported" is correct until a device-scoped identity key (with a stable
  // device id) exists to validate against.
  antigravity: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  kimi: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  droid: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  opencode: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  // Cursor multi-account isolation is unresolved (RUSH-2400) — blocked from
  // native naming/attachment; its API-key path is a provider account instead.
  cursor: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  // Discoverable in the list, but not nameable.
  gemini: { inspection: 'email', scope: 'unsupported', status: 'discovery-only' },
  copilot: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  openclaw: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  amp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  kiro: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  goose: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  hermes: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  pi: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  warp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
};

export function nativeAccountCapability(agent: AgentId): NativeAccountCapability {
  return NATIVE_ACCOUNT_CAPABILITIES[agent];
}

/** Whether a harness's native login can be named/attached (supported or conditional). */
export function nativeAccountNameable(agent: AgentId): boolean {
  const cap = NATIVE_ACCOUNT_CAPABILITIES[agent];
  return (cap.status === 'supported' || cap.status === 'conditional') && cap.scope !== 'unsupported';
}

/** Harnesses whose native login is fully nameable/attachable today. */
export function supportedNativeHarnesses(): AgentId[] {
  return (Object.entries(NATIVE_ACCOUNT_CAPABILITIES) as [AgentId, NativeAccountCapability][])
    .filter(([, cap]) => cap.status === 'supported')
    .map(([id]) => id)
    .sort();
}

/**
 * Named reason to refuse native name/attach, or null when the harness is
 * nameable. Provider-credential `accounts add` is a different path and MUST
 * not consult this — that surface is supported for every registered provider.
 */
export function nativeAccountNamingRefusal(agent: AgentId): string | null {
  if (nativeAccountNameable(agent)) return null;
  const cap = NATIVE_ACCOUNT_CAPABILITIES[agent];
  const suffix = `Supported today: ${supportedNativeHarnesses().join(', ')}.`;
  if (cap.scope === 'device') {
    return `${agent} accounts can't be isolated by agents-cli yet (device-scoped login). ${suffix}`;
  }
  if (agent === 'cursor') {
    return `${agent} accounts can't be isolated by agents-cli yet (multi-account isolation unresolved). ${suffix}`;
  }
  if (cap.status === 'discovery-only') {
    return `${agent} native accounts are discovery-only; agents-cli cannot name or attach this login. ${suffix}`;
  }
  return `${agent} accounts can't be named by agents-cli yet. ${suffix}`;
}

/** Fail loud on the native name/attach path for an unsupported harness. */
export function assertNativeAccountNameable(agent: AgentId): void {
  const reason = nativeAccountNamingRefusal(agent);
  if (reason) throw new Error(reason);
}

/**
 * The single identity key used at `accounts name`, attach, exec validation,
 * view, and inventory. Prefer the harness's stable `accountKey`. For an
 * email-only (`conditional`) harness, email is a presence gate — the stored
 * key is still `accountKey` (e.g. `muse:email=user@x.com`), never the bare
 * address, so `run`/`view` compare against the same value `getAccountInfo`
 * returns.
 */
export function nativeIdentityKey(
  info: { signedIn?: boolean; email?: string | null; accountKey?: string | null },
  capability: NativeAccountCapability,
): string | null {
  if (!info.signedIn) return null;
  if (capability.inspection === 'email' && !info.email) return null;
  return info.accountKey ?? info.email?.toLowerCase() ?? null;
}
