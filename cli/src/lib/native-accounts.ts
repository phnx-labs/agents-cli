/**
 * Native-account lookup leaf (PHNX-3940).
 *
 * A PURE, types-only module: it answers "which registered account is this
 * email / what does its identity key decode to" from a `Meta` snapshot passed
 * in by the caller — it never reads state, the keychain, or the network, and it
 * imports nothing from `account-registry` (which imports the agent-spec engine).
 * That import-graph constraint is load-bearing: `agent-spec/agents.ts`
 * completes an email-only worker home from the registry row here, and importing
 * `account-registry` there would be a cycle. `account-registry` re-exports both
 * functions so existing callers keep one import site.
 *
 * The merge of central (`accounts.native`, `scope:'version'`) and device-scoped
 * (`deviceAccounts.native`) rows mirrors `listNativeAccounts`, inlined so this
 * module stays a leaf.
 */
import type { AgentId, Meta, NativeAccountRecord } from './types.js';

/** Central + device-scoped native rows, device winning on a shared id. */
function mergedNativeAccounts(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): NativeAccountRecord[] {
  const merged = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  return Object.values(merged);
}

/**
 * The one native row for `agent` whose `identityLabel` (email) matches, or null.
 *
 * Returns null when zero OR several rows match — never guesses. Several rows can
 * share one email (a Team seat AND a personal Max under the same address are two
 * accounts, two orgs), and picking one would attribute a worker home to the
 * wrong org. The read-side caller falls closed to email-only identity in that
 * case, which is correct: an ambiguous identity is better left unresolved than
 * resolved wrong.
 */
export function registeredNativeAccountForEmail(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agent: AgentId,
  email: string,
): NativeAccountRecord | null {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  const matches = mergedNativeAccounts(meta).filter(
    (account) => account.agent === agent && account.identityLabel?.trim().toLowerCase() === needle,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Decode an `<agent>:<label>=<value>[:<label>=<value>…]` identity key into its
 * parts, or null when it does not belong to `agent` or is malformed. The key
 * shape is what `buildIdentityKey` in `agent-spec/agents.ts` writes — e.g.
 * `claude:account=<uuid>:org=<uuid>` → `{ account, org }`.
 */
export function parseNativeIdentityKey(
  agent: AgentId,
  identityKey: string,
): Record<string, string> | null {
  const prefix = `${agent}:`;
  if (!identityKey.startsWith(prefix)) return null;
  const parts: Record<string, string> = {};
  for (const segment of identityKey.slice(prefix.length).split(':')) {
    const eq = segment.indexOf('=');
    if (eq < 1 || eq === segment.length - 1) return null;
    parts[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  return Object.keys(parts).length > 0 ? parts : null;
}
