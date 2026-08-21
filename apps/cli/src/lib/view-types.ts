import type { ConfiguredModelSource } from './models.js';
import type { ProfileSummary } from './profiles.js';
import type { AgentId } from './types.js';

export type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

export interface ViewJsonVersion {
  version: string;
  isDefault: boolean;
  isolated: boolean;
  isIsolatedDefault: boolean;
  signedIn: boolean;
  email: string | null;
  accountId?: string | null;
  organizationType?: string | null;
  organizationName?: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  overageCredits?: { amount: number; currency: string } | null;
  windows: Array<{
    key: 'session' | 'week' | 'sonnet_week' | 'month';
    label?: string;
    usedPercent: number;
    resetsAt: string | null;
  }>;
  unavailable?: {
    reason: 'session_limit';
    resetsAt: string;
  };
  lastActive: string | null;
  path: string;
  configuredModel?: { model: string; source: ConfiguredModelSource } | null;
  resources?: VersionResourcesJson;
}

export interface ViewJsonAgent {
  agent: AgentId;
  versions: ViewJsonVersion[];
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
