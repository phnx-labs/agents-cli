import * as crypto from 'node:crypto';
import type { AgentId, Meta } from '../types.js';
import { nativeAccountCapability, nativeAccountNamingRefusal } from '../account-capabilities.js';
import { listNativeAccounts, type NativeAccount } from '../account-registry.js';

/**
 * `agents accounts connect <harness> [name]` — the stable-account front door
 * (PHNX-3940).
 *
 * An account is stable INDEPENDENT of releases: connecting a NEW account mints a
 * fresh opaque installation label, installs the current release into that
 * label's isolated home (even when the same release is already installed under
 * another label), and launches the harness's own native login there — no
 * credential is copied or refreshed, the OAuth login stays owned by the harness.
 * Reconnecting a NAMED EXISTING account reuses that account's existing home and
 * fails CLOSED if the completed login is a different identity, so a reconnect can
 * never overwrite some other account's home.
 *
 * This module owns the release-independent decision (plan), the opaque label,
 * and the fail-closed identity check. The actual install + login spawn is
 * injected (`ConnectRunners`) so the pure decision path is testable without a
 * network install or a TTY, and so the parent can own the real E2E login+verify.
 */

/**
 * Ambient provider-credential env vars stripped before a native login spawn, so
 * the OAuth flow authenticates as the human's identity rather than being
 * short-circuited by an injected API key / setup-token that would impersonate a
 * different account into the fresh home.
 */
const PROVIDER_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
] as const;

/** Which harnesses `connect` supports, and how their native login is launched. */
export interface LoginInvocation {
  /** argv passed to the installed binary to start the native login. */
  args: string[];
  /** Flag that pre-fills the login email (appended as `[emailFlag, email]`), when supported. */
  emailFlag?: string;
  /** One-line hint shown before the login flow takes over. */
  hint?: string;
}

/**
 * Native-login invocation per harness. Only harnesses with a REAL, finite login
 * COMMAND are listed — connect fails clearly for anything else rather than faking
 * a flow that never signs the user in. Verified against the installed CLIs
 * (PHNX-3940): `claude auth login --help` → "Sign in to your Anthropic account"
 * with `--email`; `codex login` drives the OAuth flow. A harness is added here
 * only once its isolated login command is verified.
 */
const LOGIN_INVOCATIONS: Partial<Record<AgentId, LoginInvocation>> = {
  claude: { args: ['auth', 'login'], emailFlag: '--email', hint: 'Complete the Claude sign-in in your browser.' },
  codex: { args: ['login'] },
};

/** Whether `connect` can drive this harness (isolation + a real native login). */
export function connectSupported(agent: AgentId): boolean {
  const cap = nativeAccountCapability(agent);
  return cap.scope === 'version' && !!LOGIN_INVOCATIONS[agent];
}

/**
 * Named reason connect refuses a harness, or null when supported. Distinguishes
 * "cannot isolate/name this login" (capability) from "no native login command
 * wired yet" so the message is honest about which limit was hit.
 */
export function connectRefusal(agent: AgentId): string | null {
  const capabilityRefusal = nativeAccountNamingRefusal(agent);
  if (capabilityRefusal) return capabilityRefusal;
  const cap = nativeAccountCapability(agent);
  if (cap.scope !== 'version') {
    return `${agent} authentication is ${cap.scope}-scoped; connect creates per-account isolated homes, which needs a version-scoped login.`;
  }
  if (!LOGIN_INVOCATIONS[agent]) {
    const supported = Object.keys(LOGIN_INVOCATIONS).sort().join(', ');
    return `connect does not yet drive ${agent}'s native login. Supported: ${supported}.`;
  }
  return null;
}

export function assertConnectSupported(agent: AgentId): void {
  const reason = connectRefusal(agent);
  if (reason) throw new Error(reason);
}

export function loginInvocation(agent: AgentId): LoginInvocation {
  const invocation = LOGIN_INVOCATIONS[agent];
  if (!invocation) throw new Error(`No native login command is wired for ${agent}.`);
  return invocation;
}

/** Mint a fresh, opaque, stable installation label for a NEW UNNAMED connect. */
export function mintConnectLabel(): string {
  // `acct-<hex>` — alnum + hyphen only, so it satisfies VERSION_RE, and is
  // visibly an account slot rather than a release. Never derived from identity.
  return `acct-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Deterministic, opaque slot for a NAMED connect (PHNX-3940). Derived from the
 * user-chosen name (NOT the OAuth identity), so a failed/cancelled connect that
 * is retried reuses the SAME home instead of minting a fresh orphan slot each
 * time — `installVersion` is idempotent into an existing dir and preserves its
 * home. Account names are unique per harness, so the slot is collision-free.
 */
export function connectLabelForName(agent: AgentId, name: string): string {
  const digest = crypto.createHash('sha1').update(`${agent}:${name.toLowerCase()}`).digest('hex').slice(0, 12);
  return `acct-${digest}`;
}

export type ConnectMode = 'new' | 'reconnect';

export interface ConnectPlan {
  mode: ConnectMode;
  agent: AgentId;
  /** The installation label whose isolated home hosts this account's login. */
  label: string;
  /** The human account name to register (new) or already registered (reconnect). */
  name?: string;
  /** For reconnect: the existing account being re-authenticated. */
  existing?: NativeAccount;
  /**
   * For reconnect: the label was ADOPTED (freshly minted) because the existing
   * account carried no recorded home and none was discoverable — so its identity
   * must still be re-verified against the login, but there is no prior home to
   * reuse. `false` when an existing home is being reused.
   */
  adoptedHome?: boolean;
}

/**
 * Resolve the home to reuse for reconnecting an existing account: THIS box's
 * recorded connect home first (device-scoped, survives an expired credential),
 * else a currently-signed-in local home carrying its identity. Returns null when
 * neither is known — a legacy account with no recorded or live home, for which
 * connect adopts a fresh home.
 */
export function resolveExistingHomeLabel(
  existing: NativeAccount,
  deviceHome: string | null,
  signedInHomes: Array<{ agent: AgentId; identityKey: string; label: string }>,
): string | null {
  if (deviceHome) return deviceHome;
  const match = signedInHomes.find(h => h.agent === existing.agent && h.identityKey === existing.identityKey);
  return match?.label ?? null;
}

/**
 * Decide the release-independent connect plan (pure). `existing` is the native
 * account the name resolves to for THIS harness (or null for a new connect);
 * `existingHomeLabel` is its reusable home from {@link resolveExistingHomeLabel}.
 */
export function planConnect(input: {
  agent: AgentId;
  name?: string;
  existing: NativeAccount | null;
  existingHomeLabel: string | null;
  mintLabel?: () => string;
}): ConnectPlan {
  const mint = input.mintLabel ?? mintConnectLabel;
  if (input.existing) {
    const reuse = input.existingHomeLabel;
    return {
      mode: 'reconnect',
      agent: input.agent,
      label: reuse ?? connectLabelForName(input.agent, input.existing.name),
      name: input.existing.name,
      existing: input.existing,
      adoptedHome: !reuse,
    };
  }
  // A NAMED new connect gets a deterministic slot so a retry reuses the same
  // home; an unnamed connect has no stable key, so it mints a fresh one.
  const label = input.name ? connectLabelForName(input.agent, input.name) : mint();
  return { mode: 'new', agent: input.agent, label, name: input.name };
}

/**
 * Fail-closed identity check after the login completes (pure).
 *
 * - Not signed in (no live credential) → the login did not complete; a metadata
 *   identity key alone is NOT proof, so `signedIn` is required.
 * - Reconnect whose completed identity differs from the account's → REFUSE
 *   registering the binding. The native credential in that home DID change (the
 *   user signed in), so the message says the account BINDING is left unchanged —
 *   it does not claim nothing happened.
 * A new connect accepts whatever identity signed in (that is the account being
 * created); the caller registers it.
 */
export function verifyConnectedIdentity(
  plan: ConnectPlan,
  observed: Pick<ObservedIdentity, 'identityKey' | 'signedIn'>,
): void {
  if (!observed.signedIn || !observed.identityKey) {
    throw new Error(`No ${plan.agent} login completed in ${plan.agent}@${plan.label} (no live credential). Nothing was connected.`);
  }
  if (plan.mode === 'reconnect' && plan.existing && observed.identityKey !== plan.existing.identityKey) {
    throw new Error(
      `The ${plan.agent} login that just completed in ${plan.agent}@${plan.label} is a different identity `
      + `(${observed.identityKey}) than account '${plan.existing.name}' (${plan.existing.identityKey}). `
      + `Account '${plan.existing.name}' still points at its original identity (binding unchanged); `
      + `connect a NEW account for this login instead.`,
    );
  }
}

/** Resolve the existing native account a connect `name` refers to for a harness. */
export function findConnectAccount(agent: AgentId, name: string | undefined, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  return listNativeAccounts(meta).find(a =>
    a.agent === agent && (a.id === name || a.name.toLowerCase() === needle || a.identityLabel?.toLowerCase() === needle),
  ) ?? null;
}

/** The observed identity of a completed login. */
export interface ObservedIdentity {
  identityKey: string | null;
  email: string | null;
  releaseVersion: string | null;
  /** Live credential presence — proof of sign-in, not just a metadata identity claim. */
  signedIn: boolean;
}

/**
 * Side-effecting operations connect needs, injected so the planning/verification
 * path is unit-testable and the parent can own the real E2E login+verify.
 */
export interface ConnectRunners {
  installedLabels(agent: AgentId): string[];
  /** Install the CURRENT release into `label`'s isolated home (opaque label). */
  install(agent: AgentId, label: string, onProgress?: (m: string) => void): Promise<{ success: boolean; error?: string }>;
  /** Launch the harness's native login under `label`'s home; resolves on exit. */
  launchLogin(agent: AgentId, label: string, invocation: LoginInvocation, email?: string): Promise<{ code: number | null }>;
  observeIdentity(agent: AgentId, label: string): Promise<ObservedIdentity>;
  signedInHomes(): Promise<Array<{ agent: AgentId; identityKey: string; label: string }>>;
}

export interface ConnectResult {
  mode: ConnectMode;
  agent: AgentId;
  label: string;
  name?: string;
  identityKey: string;
  email: string | null;
  releaseVersion: string | null;
}

/**
 * Drive one `agents accounts connect`. Pure decisions (plan, fail-closed verify)
 * come from the helpers above; the install + login + identity read are injected.
 *
 * The default runners are loaded via dynamic import so this module — reachable
 * from `account-registry` consumers — never statically pulls in the install
 * engine or exec path and closes an import cycle (the intended pattern here).
 */
export async function runConnect(
  agent: AgentId,
  name: string | undefined,
  opts: { meta: Pick<Meta, 'accounts' | 'deviceAccounts'>; onProgress?: (m: string) => void } ,
  runners?: ConnectRunners,
): Promise<ConnectResult> {
  assertConnectSupported(agent);
  const run = runners ?? await defaultConnectRunners();
  const registry = await import('../account-registry.js');

  const existing = findConnectAccount(agent, name, opts.meta);
  // Validate the requested NAME and its collisions BEFORE any install or login,
  // so a bad name never mints an orphan home and drives a login that can't be
  // recorded. Only a genuinely NEW named connect needs this (a reconnect names an
  // account that already passed the check).
  if (!existing && name) registry.assertNativeAccountNameAvailable(name, agent);

  const existingHomeLabel = existing
    ? resolveExistingHomeLabel(existing, registry.nativeAccountHome(existing.id, opts.meta), await run.signedInHomes())
    : null;
  const plan = planConnect({ agent, name, existing, existingHomeLabel });

  // Reconnect guard: before touching a REUSED home, refuse if it is presently
  // signed in as a DIFFERENT identity than the account — launching a login there
  // would overwrite that identity before the post-login check could catch it.
  if (plan.mode === 'reconnect' && !plan.adoptedHome && run.installedLabels(agent).includes(plan.label)) {
    const current = await run.observeIdentity(agent, plan.label);
    if (current.signedIn && current.identityKey && current.identityKey !== plan.existing!.identityKey) {
      throw new Error(
        `${agent}@${plan.label} is currently signed in as a different identity (${current.identityKey}) than `
        + `account '${plan.existing!.name}'. Refusing to launch a login that would overwrite it.`,
      );
    }
  }

  // Install the current release into the account's home. A reconnect that reuses
  // an already-installed home skips the install (reuse, don't re-mint); a new
  // account (or an adopted reconnect home) installs the current release under its
  // opaque label even when the same release is already installed elsewhere. A
  // retried named connect reuses the same deterministic slot rather than orphaning.
  const alreadyInstalled = run.installedLabels(agent).includes(plan.label);
  if (!(alreadyInstalled && (plan.mode === 'reconnect' || !!name))) {
    opts.onProgress?.(`Installing ${agent} into ${plan.label}…`);
    const install = await run.install(agent, plan.label, opts.onProgress);
    if (!install.success) throw new Error(`Could not install ${agent} for the account home: ${install.error ?? 'unknown error'}`);
  }

  const invocation = loginInvocation(agent);
  if (invocation.hint) opts.onProgress?.(invocation.hint);
  const loginEmail = existing?.identityLabel;
  const login = await run.launchLogin(agent, plan.label, invocation, loginEmail);
  // A cancelled or failed login exits non-zero — do NOT read stale metadata and
  // report success. Fail before observe/record.
  if (login.code !== 0) {
    throw new Error(`${agent} login did not complete (exit ${login.code ?? 'null'}) in ${agent}@${plan.label}. Nothing was recorded; re-run to retry the same home.`);
  }

  const observed = await run.observeIdentity(agent, plan.label);
  verifyConnectedIdentity(plan, observed);
  const identityKey = observed.identityKey!;

  // Persist THIS box's account⇄home binding (device-scoped) so a later reconnect
  // reuses this exact home even after the credential expires.
  if (plan.mode === 'new') {
    if (name) {
      const account = registry.addNativeAccount(name, agent, identityKey, observed.email ?? undefined, 'version');
      registry.setNativeAccountHome(account.id, plan.label);
    }
  } else if (existing) {
    registry.setNativeAccountHome(existing.id, plan.label);
  }

  return {
    mode: plan.mode,
    agent,
    label: plan.label,
    name: plan.name ?? name,
    identityKey,
    email: observed.email,
    releaseVersion: observed.releaseVersion,
  };
}

/** Real runners: the install engine, an inherited-stdio login spawn, and identity read. */
async function defaultConnectRunners(): Promise<ConnectRunners> {
  const [{ installVersion, getVersionHomePath, listInstalledVersions }, store, agentsMod, execMod] = await Promise.all([
    import('../installations/versions.js'),
    import('../installations/store.js'),
    import('../agents.js'),
    import('../exec.js'),
  ]);
  const { readInstallation } = store;
  const { getAccountInfo } = agentsMod;
  const { buildExecEnv } = execMod;
  const { nativeAccountCapability, nativeIdentityKey } = await import('../account-capabilities.js');
  const { runNativeAccountCommand } = await import('../installations/native-command.js');

  return {
    installedLabels: (agent) => listInstalledVersions(agent),
    install: async (agent, label, onProgress) => {
      const result = await installVersion(agent, 'latest', onProgress, { installationLabel: label });
      return { success: result.success, error: result.error };
    },
    launchLogin: async (agent, label, invocation, email) => {
      // Pin the harness's own config-dir env (CLAUDE_CONFIG_DIR / CODEX_HOME) to
      // this label's isolated home so the native login lands there — no
      // credential is copied; the login writes into the home it authenticates.
      const env = buildExecEnv({ agent, version: label, configVersion: label, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
      // Strip any ambient provider API-key / setup-token env so the native login
      // authenticates as the human's OAuth identity, not an injected credential
      // that would impersonate a different account into this home.
      for (const key of PROVIDER_AUTH_ENV_KEYS) delete env[key];
      const args = email && invocation.emailFlag ? [...invocation.args, invocation.emailFlag, email] : invocation.args;
      return runNativeAccountCommand(agent, label, args, env);
    },
    observeIdentity: async (agent, label) => {
      const info = await getAccountInfo(agent, getVersionHomePath(agent, label));
      return {
        identityKey: nativeIdentityKey(info, nativeAccountCapability(agent)),
        email: info.email,
        releaseVersion: readInstallation(agent, label)?.releaseVersion ?? null,
        signedIn: info.signedIn,
      };
    },
    signedInHomes: async () => {
      const { collectNativeHomeRows } = await import('../account-catalog.js');
      const rows = await collectNativeHomeRows();
      return rows
        .filter(r => r.signedIn && (r.accountKey ?? r.email))
        .map(r => ({ agent: r.agent, identityKey: (r.accountKey ?? r.email!.toLowerCase()), label: r.label }));
    },
  };
}
