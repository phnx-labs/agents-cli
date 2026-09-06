import * as crypto from 'node:crypto';
import type { AgentId, Meta } from '../types.js';
import { nativeAccountCapability, nativeAccountNamingRefusal } from '../account-capabilities.js';
import { listNativeAccounts, type NativeAccount } from '../account-registry.js';
import { providerAuthenticatesHarness } from '../account-provider-registry.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from '../device-config.js';
import { machineId } from '../machine-id.js';
import { readMeta } from '../state.js';
import { acquireAuthOperationLock, type AuthOperationLock } from './auth-operation-lock.js';

/**
 * `agents accounts connect <harness> [name]` — the stable-account front door
 * (PHNX-3940).
 *
 * Headed devices only. A worker (or unmarked box) is refused before any slot,
 * install, or browser login — workers never run an interactive OAuth flow
 * (credential-management.md invariant 7). Add the account on a personal/desktop
 * box; workers are provisioned from the durable credential.
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

/**
 * Native API-key provider for a harness that workers provision from a portable
 * credential (credential-management.md invariant 7). The id is the registry
 * adapter that authenticates this harness with `api-key` — not a parallel
 * invention. Claude is a setup-token, not an API key, and is handled separately.
 */
const NATIVE_API_KEY_PROVIDER: Partial<Record<AgentId, string>> = {
  codex: 'openai',
  grok: 'xai',
  opencode: 'opencode',
  gemini: 'google',
};

function nativeApiKeyProvider(agent: AgentId): string | null {
  const id = NATIVE_API_KEY_PROVIDER[agent];
  if (!id) return null;
  if (!providerAuthenticatesHarness(id, 'api-key', agent)) {
    throw new Error(`Internal: provider '${id}' does not authenticate ${agent} with an api-key.`);
  }
  return id;
}

function workerCredentialHint(agent: AgentId, name: string | undefined, device: string): string {
  if (agent === 'claude') return 'the setup-token minted by agents accounts mint claude';
  const provider = nativeApiKeyProvider(agent);
  if (provider) {
    const account = name ?? '<name>';
    return `a provider API key — agents accounts add ${account} --provider ${provider} then agents accounts sync ${account} ${device}`;
  }
  return `no portable credential; log in per box with agents fleet login ${agent}`;
}

/**
 * Named reason connect refuses on a non-headed device, or null when this box
 * may run an interactive login. Workers never mint a native OAuth login
 * (credential-management.md invariant 7 + Provisioning model).
 */
export function connectWorkerRefusal(agent: AgentId, name?: string): string | null {
  const role = selfConfiguredDeviceRole();
  if (isHeadedDeviceRole(role)) return null;
  const device = machineId();
  const roleLabel = role ?? 'unmarked';
  const selector = name ? `${agent}#${name}` : agent;
  const connectCmd = name
    ? `agents accounts connect ${agent} ${name}`
    : `agents accounts connect ${agent} <name>`;
  return `${selector}: this device is a worker (role ${roleLabel}) and never runs an interactive login. `
    + `Add the account on your personal device with \`${connectCmd}\`; `
    + `workers are provisioned from the durable credential automatically `
    + `(${agent}: ${workerCredentialHint(agent, name, device)}). `
    + `To mark this box as your interactive seat: agents devices role ${device} personal.`;
}

function assertConnectAllowedOnThisDevice(agent: AgentId, name?: string): void {
  const reason = connectWorkerRefusal(agent, name);
  if (reason) throw new Error(reason);
}

export function loginInvocation(agent: AgentId): LoginInvocation {
  const invocation = LOGIN_INVOCATIONS[agent];
  if (!invocation) throw new Error(`No native login command is wired for ${agent}.`);
  return invocation;
}

/**
 * Mint a fresh, opaque installation slot. `acct-<hex>` — alnum + hyphen only, so
 * it satisfies VERSION_RE, and is visibly an account slot, not a release. It is
 * RANDOM, never derived from the account name or identity: a name-derived slot
 * recomputes an already-occupied home after a rename and lets a new connect
 * overwrite another account's login (PHNX-3940 security fix). Retry-idempotency
 * is instead provided by the device-scoped pending-connect map, and collision
 * safety by allocating around occupied slots — see `allocateConnectSlot`.
 */
export function mintConnectLabel(): string {
  return `acct-${crypto.randomBytes(6).toString('hex')}`;
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
 * `existingHomeLabel` is its reusable home from {@link resolveExistingHomeLabel};
 * `freshSlot` is a safely-allocated opaque slot (see `allocateConnectSlot`) used
 * for a new connect or an adopted reconnect home — NEVER a name-derived label.
 */
export function planConnect(input: {
  agent: AgentId;
  name?: string;
  existing: NativeAccount | null;
  existingHomeLabel: string | null;
  freshSlot: string;
}): ConnectPlan {
  if (input.existing) {
    const reuse = input.existingHomeLabel;
    return {
      mode: 'reconnect',
      agent: input.agent,
      label: reuse ?? input.freshSlot,
      name: input.existing.name,
      existing: input.existing,
      adoptedHome: !reuse,
    };
  }
  return { mode: 'new', agent: input.agent, label: input.freshSlot, name: input.name };
}

/**
 * Safely allocate the opaque slot for a NEW connect or an ADOPTED reconnect home
 * (PHNX-3940 security fix). Never reuses an identity-bearing slot:
 *
 * - `occupied` is every slot already owned by an account's home OR currently
 *   signed in — an allocated slot is guaranteed disjoint from it, so a new
 *   connect can never land on another account's home (the rename-collision flaw).
 * - A named connect first reuses its device-scoped PENDING slot (a prior
 *   failed/cancelled attempt) IF that slot is not occupied, so a retry lands in
 *   the same fresh home instead of orphaning a new one.
 * - Otherwise it mints random slots until one is neither occupied nor installed.
 */
export function allocateConnectSlot(input: {
  agent: AgentId;
  name?: string;
  existing: NativeAccount | null;
  occupied: ReadonlySet<string>;
  installedLabels: ReadonlySet<string>;
  pending: string | null;
  mint?: () => string;
}): string {
  const mint = input.mint ?? mintConnectLabel;
  // Retry reuse is only for a NEW named connect (pending is keyed by name); a
  // pending slot that has since become occupied is abandoned, never overwritten.
  if (!input.existing && input.name && input.pending && !input.occupied.has(input.pending)) {
    return input.pending;
  }
  let slot = mint();
  while (input.occupied.has(slot) || input.installedLabels.has(slot)) slot = mint();
  return slot;
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
  launchLogin(agent: AgentId, label: string, invocation: LoginInvocation, email?: string, signal?: AbortSignal): Promise<{ code: number | null }>;
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
  /** True when this connect became the harness's default (only set if none was configured). */
  becameDefault: boolean;
  /** For an UNNAMED connect: the command to name the login (no name was forced). */
  nameHint?: string;
}

/**
 * Drive one `agents accounts connect`. Pure decisions (plan, fail-closed verify)
 * come from the helpers above; the install + login + identity read are injected.
 *
 * The default runners are loaded via dynamic import so this module — reachable
 * from `account-registry` consumers — never statically pulls in the install
 * engine or exec path and closes an import cycle (the intended pattern here).
 *
 * `stateDir` is only for tests: override the runtime-state dir used by the
 * per-harness auth-operation mutex (defaults to the real runtime state dir).
 */
export async function runConnect(
  agent: AgentId,
  name: string | undefined,
  opts: { meta: Pick<Meta, 'accounts' | 'deviceAccounts'>; onProgress?: (m: string) => void; stateDir?: string },
  runners?: ConnectRunners,
): Promise<ConnectResult> {
  assertConnectSupported(agent);
  // Owner rule (invariant 7): a worker NEVER runs an interactive login. Refuse
  // before the lock, slot, install, or browser — no side effects on a worker.
  assertConnectAllowedOnThisDevice(agent, name);

  // Acquire the per-harness auth-operation mutex BEFORE any meta read, slot
  // allocation, or name validation — two parallel connects for the same harness
  // would otherwise both see "name available" and "slot free", then race to
  // register the same slot or the same name, overwriting one account's home.
  const lock = acquireAuthOperationLock(agent, opts.stateDir);
  try {
    return await _runConnectLocked(agent, name, opts, lock, runners);
  } finally {
    lock.release();
  }
}

async function _runConnectLocked(
  agent: AgentId,
  name: string | undefined,
  opts: { meta: Pick<Meta, 'accounts' | 'deviceAccounts'>; onProgress?: (m: string) => void },
  lock: AuthOperationLock,
  runners?: ConnectRunners,
): Promise<ConnectResult> {
  const run = runners ?? await defaultConnectRunners();
  const registry = await import('../account-registry.js');
  lock.assertHeld();

  // Re-read meta AFTER acquiring the lock so we see any writes a concurrent
  // connect committed before we were serialized past it. `opts.meta` was a
  // snapshot taken before the lock was available and must not be used here.
  const meta = readMeta();
  const existing = findConnectAccount(agent, name, meta);
  // Validate the requested NAME and its collisions BEFORE any install or login,
  // so a bad name never mints an orphan home and drives a login that can't be
  // recorded. Only a genuinely NEW named connect needs this (a reconnect names an
  // account that already passed the check).
  if (!existing && name) registry.assertNativeAccountNameAvailable(name, agent);

  const signedIn = await run.signedInHomes();
  lock.assertHeld();
  const existingHomeLabel = existing
    ? resolveExistingHomeLabel(existing, registry.nativeAccountHome(existing.id, meta), signedIn)
    : null;

  // SECURITY (PHNX-3940): allocate a fresh slot that is DISJOINT from every
  // occupied home — a slot already owned by an account OR currently signed in.
  // This is what stops a NEW connect (e.g. `connect work` after `work` was
  // renamed `personal`) from landing on and overwriting another account's login.
  const occupied = new Set<string>([
    ...registry.ownedConnectHomeLabels(meta),
    ...signedIn.filter(h => h.agent === agent).map(h => h.label),
  ]);
  const freshSlot = allocateConnectSlot({
    agent,
    name,
    existing,
    occupied,
    installedLabels: new Set(run.installedLabels(agent)),
    pending: (!existing && name) ? registry.pendingConnectSlot(agent, name, meta) : null,
  });
  // Record the in-flight slot for a named connect so a failed retry reuses it.
  if (!existing && name && freshSlot !== registry.pendingConnectSlot(agent, name, meta)) {
    registry.setPendingConnectSlot(agent, name, freshSlot);
  }

  const plan = planConnect({ agent, name, existing, existingHomeLabel, freshSlot });

  // Pre-launch guard (both modes): if the chosen home is already installed AND
  // signed in, refuse to launch a login that would OVERWRITE its identity —
  // unless it is the SAME identity we are (re)connecting. For a NEW connect any
  // signed-in identity is a stranger; for a reconnect only a DIFFERENT one is.
  if (run.installedLabels(agent).includes(plan.label)) {
    const current = await run.observeIdentity(agent, plan.label);
    lock.assertHeld();
    const intended = existing?.identityKey;
    if (current.signedIn && current.identityKey && current.identityKey !== intended) {
      throw new Error(
        `${agent}@${plan.label} is currently signed in as ${current.identityKey}`
        + `${existing ? ` (not account '${existing.name}')` : ''}. `
        + `Refusing to launch a login that would overwrite it.`,
      );
    }
  }

  // Install the current release into the account's home. A reconnect that reuses
  // an already-installed home skips the install (reuse, don't re-mint); a new
  // account (or an adopted reconnect home) installs the current release under its
  // opaque label even when the same release is already installed elsewhere. A
  // retried named connect reuses the same pending slot rather than orphaning.
  const alreadyInstalled = run.installedLabels(agent).includes(plan.label);
  lock.assertHeld();
  if (!(alreadyInstalled && (plan.mode === 'reconnect' || !!name))) {
    opts.onProgress?.(`Installing ${agent} into ${plan.label}…`);
    const install = await run.install(agent, plan.label, opts.onProgress);
    lock.assertHeld();
    if (!install.success) throw new Error(`Could not install ${agent} for the account home: ${install.error ?? 'unknown error'}`);
  }

  const invocation = loginInvocation(agent);
  if (invocation.hint) opts.onProgress?.(invocation.hint);
  const loginEmail = existing?.identityLabel;
  lock.assertHeld();
  const login = await run.launchLogin(agent, plan.label, invocation, loginEmail, lock.signal);
  lock.assertHeld();
  // A cancelled or failed login exits non-zero — do NOT read stale metadata and
  // report success. A NAMED connect can retry the same home (its slot is pending);
  // an UNNAMED connect has no pending slot, so a re-run allocates a new home.
  if (login.code !== 0) {
    const retry = name ? 're-run to retry the same home' : 're-run to try again (a new home is allocated)';
    throw new Error(`${agent} login did not complete (exit ${login.code ?? 'null'}) in ${agent}@${plan.label}. Nothing was recorded; ${retry}.`);
  }

  const observed = await run.observeIdentity(agent, plan.label);
  lock.assertHeld();
  verifyConnectedIdentity(plan, observed);
  const identityKey = observed.identityKey!;

  // Persist THIS box's account⇄home binding (device-scoped) so a later reconnect
  // reuses this exact home even after the credential expires, and clear the
  // in-flight pending slot now that it is a real account home.
  let becameDefault = false;
  let nameHint: string | undefined;
  if (plan.mode === 'new') {
    if (name) {
      const account = registry.addNativeAccount(name, agent, identityKey, observed.email ?? undefined, 'version');
      registry.setNativeAccountHome(account.id, plan.label);
      registry.clearPendingConnectSlot(agent, name);
      // Select this account as the harness default ONLY if none is configured —
      // never override an existing choice, and never force a duplicate name.
      becameDefault = registry.setDefaultAccountIfAbsent(agent, account.name);
    } else {
      // No name was given: do not invent/force one. Point the user at the command
      // that names this login so it becomes selectable and default-eligible.
      nameHint = `agents accounts label ${agent} <name>`;
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
    becameDefault,
    nameHint,
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
    launchLogin: async (agent, label, invocation, email, signal) => {
      // Pin the harness's own config-dir env (CLAUDE_CONFIG_DIR / CODEX_HOME) to
      // this label's isolated home so the native login lands there — no
      // credential is copied; the login writes into the home it authenticates.
      const env = buildExecEnv({ agent, version: label, configVersion: label, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
      // Strip any ambient provider API-key / setup-token env so the native login
      // authenticates as the human's OAuth identity, not an injected credential
      // that would impersonate a different account into this home.
      for (const key of PROVIDER_AUTH_ENV_KEYS) delete env[key];
      const args = email && invocation.emailFlag ? [...invocation.args, invocation.emailFlag, email] : invocation.args;
      return runNativeAccountCommand(agent, label, args, env, signal);
    },
    observeIdentity: async (agent, label) => {
      const home = getVersionHomePath(agent, label);
      const info = await getAccountInfo(agent, home);
      const { isLaunchableSignedIn } = await import('../account-catalog.js');
      return {
        identityKey: nativeIdentityKey(info, nativeAccountCapability(agent)),
        email: info.email,
        releaseVersion: readInstallation(agent, label)?.releaseVersion ?? null,
        // Strict: a live credential in THIS home, not a bare metadata identity.
        signedIn: isLaunchableSignedIn(agent, home, info),
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
