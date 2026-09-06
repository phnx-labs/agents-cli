/**
 * Per-harness auth capability table (PHNX-3940).
 *
 * One row per `ALL_AGENT_IDS` entry. Governs `accounts add` / connect login
 * argv, identity strength, the durable worker credential (if any), and the
 * config-dir env that pins a slot. Completeness is pinned by the test against
 * `ALL_AGENT_IDS` — a new harness without a row is a type error and a failing
 * test, never a silent skip.
 *
 * Values are taken from evidence-harness-auth.md (2026-09-06) and the adapters
 * under `lib/harness/adapters/`. `LOGIN_INVOCATIONS` is the connect-era subset
 * (claude, codex) derived from this table so existing connect callers keep
 * working until T4 folds connect into `accounts add`.
 */
import type { AgentId } from './types.js';

export type HarnessIdentityKind = 'strong' | 'email' | 'opaque';

/**
 * Durable worker credential, or `none` when the harness must log in per box.
 * Codex is both: an API key (portable, bills the API) OR a per-device
 * ChatGPT-plan device-auth login (the plan seat; never stored in the reserved
 * store because it is a rotating session).
 */
export type HarnessWorkerKind =
  | 'setup-token'
  | 'none'
  | `api-key:${string}`
  | `per-device${'' | `:${string}`}`;

export type HarnessWorker = HarnessWorkerKind | HarnessWorkerKind[];

export interface HarnessAuthCapability {
  /** argv after the harness binary to start native login, or null when there is no finite login command. */
  login: string[] | null;
  /** argv to probe login status, or null when the CLI has no status command. */
  status: string[] | null;
  identity: HarnessIdentityKind;
  worker: HarnessWorker;
  /** Config-dir env that pins a slot, or null when isolation is HOME-swap only. */
  slotEnv: string | null;
}

export const HARNESS_AUTH: Record<AgentId, HarnessAuthCapability> = {
  claude: { login: ['auth', 'login'], status: ['auth', 'status'], identity: 'strong', worker: 'setup-token', slotEnv: 'CLAUDE_CONFIG_DIR' },
  codex: { login: ['login'], status: ['login', 'status'], identity: 'strong', worker: ['api-key:OPENAI_API_KEY', 'per-device:device-auth'], slotEnv: 'CODEX_HOME' },
  grok: { login: ['login'], status: null, identity: 'strong', worker: 'api-key:XAI_API_KEY', slotEnv: 'GROK_HOME' },
  opencode: { login: ['auth', 'login'], status: ['auth', 'list'], identity: 'email', worker: 'api-key:provider', slotEnv: 'XDG_DATA_HOME' },
  cursor: { login: ['login'], status: ['status'], identity: 'strong', worker: 'api-key:CURSOR_API_KEY', slotEnv: null },
  kimi: { login: ['login'], status: null, identity: 'opaque', worker: 'none', slotEnv: 'KIMI_CODE_HOME' },
  antigravity: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  droid: { login: null, status: null, identity: 'opaque', worker: 'api-key:FACTORY_API_KEY', slotEnv: null },
  gemini: { login: null, status: null, identity: 'email', worker: 'none', slotEnv: null },
  copilot: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: 'COPILOT_HOME' },
  openclaw: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  amp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  goose: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  hermes: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  muse: { login: null, status: null, identity: 'email', worker: 'none', slotEnv: null },
  warp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
};

export function harnessAuth(agent: AgentId): HarnessAuthCapability {
  const cap = HARNESS_AUTH[agent];
  if (!cap) throw new Error(`No harness-auth capability for '${agent}'.`);
  return cap;
}

/** Worker kinds as a flat list (codex's dual path is two entries). */
export function harnessWorkerKinds(agent: AgentId): HarnessWorkerKind[] {
  const worker = harnessAuth(agent).worker;
  return Array.isArray(worker) ? worker : [worker];
}

/**
 * Native-login invocation per harness. Only harnesses with a REAL, finite login
 * COMMAND that connect currently drives — connect fails clearly for anything
 * else rather than faking a flow that never signs the user in. Verified against
 * the installed CLIs (PHNX-3940): `claude auth login --help` → "Sign in to your
 * Anthropic account" with `--email`; `codex login` drives the OAuth flow.
 * Args are the `HARNESS_AUTH.login` values for the same ids.
 */
export interface LoginInvocation {
  /** argv passed to the installed binary to start the native login. */
  args: string[];
  /** Flag that pre-fills the login email (appended as `[emailFlag, email]`), when supported. */
  emailFlag?: string;
  /** One-line hint shown before the login flow takes over. */
  hint?: string;
}

export const LOGIN_INVOCATIONS: Partial<Record<AgentId, LoginInvocation>> = {
  claude: {
    args: HARNESS_AUTH.claude.login!,
    emailFlag: '--email',
    hint: 'Complete the Claude sign-in in your browser.',
  },
  codex: { args: HARNESS_AUTH.codex.login! },
};
