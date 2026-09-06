import { ALL_AGENT_IDS, credentialPresence, getAccountInfo, supportsAccountInspection, type AccountInfo } from './agents.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import { readInstallation } from './installations/store.js';
import { readMeta } from './state.js';
import { listNativeAccounts, readAccountRegistry, type CredentialAccount } from './account-registry.js';
import type { AgentId, Meta } from './types.js';

/**
 * Strict "is this home actually connected?" — a live CREDENTIAL in that exact
 * version home, not just a metadata identity claim (PHNX-3940). A `.claude.json`
 * carrying an `oauthAccount` block with no `.credentials.json`/`.oauth_token`
 * beside it is stale/expired, and must read as `reconnect-needed`, never
 * `connected`. Where agents-cli does not know the credential location
 * (`knownLocation` false), it falls back to the metadata `signedIn` since there
 * is nothing stricter to check.
 */
export function isLaunchableSignedIn(agent: AgentId, versionHome: string, info: Pick<AccountInfo, 'signedIn'>): boolean {
  if (!info.signedIn) return false;
  const cred = credentialPresence(agent, versionHome);
  return cred.knownLocation ? cred.perVersion : info.signedIn;
}

export interface NativeAccountCatalogEntry {
  kind: 'native';
  id: string;
  agent: AgentId;
  display: string;
  email: string | null;
  versions: string[];
}

export function groupNativeAccountRows(rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }>): NativeAccountCatalogEntry[] {
  const grouped = new Map<string, NativeAccountCatalogEntry>();
  for (const row of rows) {
    if (!row.signedIn) continue;
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = `${row.agent}:${identity}`;
    const existing = grouped.get(key);
    if (existing) existing.versions.push(row.version);
    else grouped.set(key, {
      kind: 'native',
      id: identity,
      agent: row.agent,
      display: row.email ?? identity,
      email: row.email,
      versions: [row.version],
    });
  }
  return [...grouped.values()].map(entry => ({ ...entry, versions: [...new Set(entry.versions)].sort() }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

/** Discover signed-in harness-native identities without copying their auth files. */
export async function discoverNativeAccounts(): Promise<NativeAccountCatalogEntry[]> {
  const rows = await collectNativeHomeRows();
  return groupNativeAccountRows(rows.map(r => ({ agent: r.agent, version: r.label, accountKey: r.accountKey, email: r.email, signedIn: r.signedIn })));
}

// ---------------------------------------------------------------------------
// Account-first read model (PHNX-3940)
//
// `agents accounts` / `agents accounts view` present the ACCOUNT and its
// connection first; the release and home are secondary diagnostics. This model
// is the one place that fold: it groups every installed native home by identity,
// merges the registered account name + connect home, and derives a connection
// state that reflects the LIVE credential rather than the registry label — a
// registered account whose home is signed out reads `reconnect-needed`, never a
// bare `connected`. `view.ts` consumes it so the human list and the per-account
// view share one truth. It is additive; the discovery helpers above stay.
// ---------------------------------------------------------------------------

/** One installed home carrying an identity — the secondary "release/home" facts. */
export interface AccountHome {
  /** The installation label (version-dir basename). */
  label: string;
  /** The vendor release the home currently carries, when the record is present. */
  releaseVersion: string | null;
  /** Whether this exact home currently has a live signed-in credential. */
  signedIn: boolean;
}

/**
 * A live credential state, derived from the homes rather than the registry:
 * - `connected` — at least one home for this identity is signed in.
 * - `reconnect-needed` — the account is registered (or was created by connect)
 *   but no home currently holds a live credential; the label alone is not a
 *   connection. `agents accounts connect <name>` re-authenticates it.
 */
export type AccountConnectionState = 'connected' | 'reconnect-needed';

/** Account-first row for a native (harness-owned OAuth) identity. */
export interface NativeAccountCatalogRow {
  kind: 'native';
  agent: AgentId;
  identityKey: string;
  /** Registered account name/label, or null for an unnamed discovered login. */
  name: string | null;
  /** Registered stable account id, or null when unnamed. */
  id: string | null;
  email: string | null;
  display: string;
  /**
   * The LOCAL installation home for this identity on THIS box: the recorded
   * connect home when installed here, else the local home carrying the login.
   * Null when no local home exists (the identity may be connected on another
   * box). Per-host by construction — never a label another box minted.
   */
  home: string | null;
  /** Every installed home carrying this identity (secondary diagnostics). */
  installations: AccountHome[];
  /** Whether the harness's configured default account points at this identity. */
  isDefault: boolean;
  state: AccountConnectionState;
}

/** Account-first row for a durable provider (API-key / token) account bundle. */
export interface ProviderAccountCatalogRow {
  kind: 'provider';
  name: string;
  id: string;
  provider: string;
  auth: string;
  baseUrl?: string;
}

export type AccountCatalogRow = NativeAccountCatalogRow | ProviderAccountCatalogRow;

export interface AccountCatalog {
  native: NativeAccountCatalogRow[];
  provider: ProviderAccountCatalogRow[];
}

/** One installed home probed for its native identity — the raw input to the fold. */
export interface NativeHomeRow {
  agent: AgentId;
  label: string;
  releaseVersion: string | null;
  accountKey: string | null;
  email: string | null;
  signedIn: boolean;
}

/** Probe every installed home of every inspectable harness for its native identity. */
export async function collectNativeHomeRows(): Promise<NativeHomeRow[]> {
  const rows: NativeHomeRow[] = [];
  for (const agent of ALL_AGENT_IDS.filter(supportsAccountInspection)) {
    for (const label of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, label);
      const info = await getAccountInfo(agent, home);
      rows.push({
        agent,
        label,
        releaseVersion: readInstallation(agent, label)?.releaseVersion ?? null,
        accountKey: info.accountKey,
        email: info.email,
        // Strict: a live credential in THIS home, not a bare metadata identity.
        signedIn: isLaunchableSignedIn(agent, home, info),
      });
    }
  }
  return rows;
}

/** The subset of Meta the pure builder reads — the registered native accounts + defaults. */
type CatalogMeta = Pick<Meta, 'accounts' | 'deviceAccounts'>;

/**
 * Fold installed homes + the registry into account-first native rows (pure).
 *
 * Every home carrying an identity contributes an `AccountHome`; the identity is
 * the group key. A registered account (name/id/connect home) is merged onto its
 * identity, and — crucially — a registered account whose identity has NO live
 * home still appears, as `reconnect-needed`, so a stale/expired login is never
 * silently dropped from the list nor shown as connected.
 */
export function buildNativeCatalog(
  rows: NativeHomeRow[],
  meta: CatalogMeta,
  globalDefault: (agent: AgentId) => string | null = getGlobalDefault,
): NativeAccountCatalogRow[] {
  const registered = listNativeAccounts(meta);
  const defaults = meta.accounts?.defaults ?? {};

  interface Group {
    agent: AgentId;
    identityKey: string;
    email: string | null;
    homes: AccountHome[];
  }
  const groups = new Map<string, Group>();
  const keyOf = (agent: AgentId, identity: string) => `${agent}:${identity}`;

  // Every installed home that carries a resolvable identity seeds a group.
  for (const row of rows) {
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = keyOf(row.agent, identity);
    const group = groups.get(key) ?? { agent: row.agent, identityKey: identity, email: null, homes: [] };
    group.email ??= row.email;
    group.homes.push({ label: row.label, releaseVersion: row.releaseVersion, signedIn: row.signedIn });
    groups.set(key, group);
  }

  // A registered account whose identity has no discovered home still belongs in
  // the catalog — it just has nothing live to connect through yet. Its
  // `identityKey` is the same value a home row groups on (a raw accountKey, or
  // an already-lowercased email), so an exact-key check finds the existing group.
  for (const account of registered) {
    const key = keyOf(account.agent, account.identityKey);
    if (!groups.has(key)) {
      groups.set(key, { agent: account.agent, identityKey: account.identityKey, email: account.identityLabel ?? null, homes: [] });
    }
  }

  const out: NativeAccountCatalogRow[] = [];
  for (const group of groups.values()) {
    const account = registered.find(a => a.agent === group.agent && a.identityKey === group.identityKey);
    const email = group.email ?? account?.identityLabel ?? null;
    const homes = [...group.homes].sort((a, b) => a.label.localeCompare(b.label));
    const signedIn = homes.some(h => h.signedIn);

    // The configured per-harness account default is AUTHORITATIVE: when present,
    // only the matching native account is the default — an explicit default that
    // names a provider (or a stale name) never invents a native default. Only
    // when NO account default is configured does the global-default installation
    // home decide (diagnostic fallback).
    const defaultRef = defaults[group.agent];
    let isDefault: boolean;
    if (defaultRef !== undefined) {
      isDefault = !!account && (account.name === defaultRef || account.id === defaultRef);
    } else {
      const gd = globalDefault(group.agent);
      isDefault = !!gd && homes.some(h => h.label === gd);
    }

    // The home is a PER-HOST fact: this box's recorded connect home when it is
    // actually installed here, else the local home carrying the identity. A home
    // label recorded on another box is never assumed to exist locally.
    const recordedHome = account ? (meta.deviceAccounts?.homes?.[account.id] ?? null) : null;
    const home = (recordedHome && homes.some(h => h.label === recordedHome))
      ? recordedHome
      : (homes.find(h => h.signedIn)?.label ?? homes[0]?.label ?? null);

    out.push({
      kind: 'native',
      agent: group.agent,
      identityKey: group.identityKey,
      name: account?.name ?? null,
      id: account?.id ?? null,
      email,
      display: email ?? account?.name ?? group.identityKey,
      home,
      installations: homes,
      isDefault,
      state: signedIn ? 'connected' : 'reconnect-needed',
    });
  }
  // Named accounts first, then default, then a stable display order.
  return out.sort((a, b) =>
    a.agent.localeCompare(b.agent)
    || Number(!!b.name) - Number(!!a.name)
    || Number(b.isDefault) - Number(a.isDefault)
    || a.display.localeCompare(b.display));
}

function toProviderRow(account: CredentialAccount): ProviderAccountCatalogRow {
  return { kind: 'provider', name: account.name, id: account.id, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl };
}

/**
 * Wire the real collectors to the pure builder. This is the canonical
 * account-first read model `view.ts` renders: native identities (account +
 * connection first, release/home secondary) plus the durable provider bundles.
 */
export async function loadAccountCatalog(): Promise<AccountCatalog> {
  const meta = readMeta();
  const native = buildNativeCatalog(await collectNativeHomeRows(), meta);
  const provider = Object.values(readAccountRegistry().accounts)
    .map(toProviderRow)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { native, provider };
}
