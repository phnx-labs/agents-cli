import type { ConfiguredModelSource } from './models.js';
import type { ProfileSummary } from './profiles.js';
import type { AgentId } from './types.js';
import type { AuthVerdict } from './auth-health.js';
import type { AccountListEntryJson } from './account-catalog.js';

export type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

export interface ViewJsonVersion {
  /** Stable installation label; retained for existing machine consumers. */
  version: string;
  /** Actual vendor release, independent of the stable installation label. */
  releaseVersion?: string;
  isDefault: boolean;
  isolated: boolean;
  isIsolatedDefault: boolean;
  signedIn: boolean;
  /**
   * Whether THIS version home can actually spawn a signed-in agent — the strict
   * per-version launch truth (`isLaunchableSignedIn`), not the display `signedIn`
   * above. `signedIn` is true when the version *inherits* the active/global HOME
   * login even with no per-version credential of its own; such a home shows "who
   * is logged in" but dies at spawn once launch isolates HOME to it. Automatic
   * `--device auto` placement gates on THIS field so a remote box is judged by
   * the same launchability the local candidate uses (`collectRunCandidates` →
   * `isLaunchableSignedIn`), closing the local/remote asymmetry (PHNX-3466).
   * Absent on an older remote CLI, whose consumers fall back to `signedIn`.
   */
  launchable: boolean;
  /** Live cached authentication verdict for this installed version. */
  authVerdict: AuthVerdict | null;
  /** Epoch milliseconds when authVerdict was last checked, or null if absent. */
  authCheckedAt: number | null;
  email: string | null;
  accountId?: string | null;
  organizationType?: string | null;
  organizationName?: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  /** ISO timestamp of the usage snapshot behind usageStatus, or null if absent. */
  usageCapturedAt: string | null;
  overageCredits?: { amount: number; currency: string } | null;
  /**
   * Human-readable reason a usage snapshot is absent: a live-refresh failure, or
   * (without `--refresh`, on a never-cached account) a plain "not collected yet"
   * pending state. Always a full sentence — never the internal `'stale'` cache
   * sentinel, which `usageErrorForDisplay` normalizes away (PHNX-3348).
   */
  usageError?: string | null;
  windows: Array<{
    key: 'session' | 'week' | 'sonnet_week' | 'month';
    label?: string;
    usedPercent: number;
    resetsAt: string | null;
  }>;
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: string;
  };
  lastActive: string | null;
  path: string;
  configuredModel?: { model: string; source: ConfiguredModelSource } | null;
  resources?: VersionResourcesJson;
}

export interface ViewJsonAgent {
  agent: AgentId;
  versions: ViewJsonVersion[];
  /**
   * The same public JSON v2 account projection `accounts list --json` emits —
   * never the internal catalog row, so consumers (AGI EXT) read one shape.
   */
  accounts?: AccountListEntryJson[];
  harnesses: ProfileSummary[];
}

export type ResourceSection = 'commands' | 'skills' | 'mcp' | 'memory' | 'hooks' | 'workflows' | 'plugins';

export interface ResourceItemJson {
  name: string;
  scope?: 'user' | 'project';
  syncState?: SyncState;
  description?: string;
  ruleCount?: number;
}

export interface VersionResourcesJson {
  commands?: ResourceItemJson[];
  skills?: ResourceItemJson[];
  mcp?: ResourceItemJson[];
  memory?: ResourceItemJson[];
  hooks?: ResourceItemJson[];
  workflows?: ResourceItemJson[];
  plugins?: ResourceItemJson[];
}
