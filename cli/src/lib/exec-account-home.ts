/**
 * Spawn-time native-account HOME resolution (PHNX-3940 T5).
 *
 * A native account's spawn HOME is that account's SLOT on this device when the
 * slot dir exists. A leftover `homes` label (legacy `acct-*` installation)
 * still resolves until T7 migrates it — T1's backfill could record a slotDir
 * that was never created, so a recorded slot that is missing on disk is not a
 * success. A worker with the durable key present materializes the slot via
 * T6 `provisionWorkerSlot`. Anything else fails loud with the T4 hint —
 * never a wrong home that looks like success.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listNativeAccounts, nativeAccountHome, type NativeAccount } from './account-registry.js';
import { readSlots } from './accounts/slots.js';
import { workerProvisioningHint } from './accounts/add.js';
import { AUTH_BUNDLE, claudeAccountTokenKey, provisionWorkerSlot, readReservedCredential } from './claude-account-token.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import { harnessWorkerKinds } from './harness-auth-capabilities.js';
import { isSymlinkAdoptedHarness } from './installations/shims.js';
import { getVersionHomePath } from './installations/versions.js';
import { getHistoryDir } from './state.js';
import type { AgentId, DeviceAccountSlot, Meta } from './types.js';

export { isSymlinkAdoptedHarness };

export type SpawnHomeSource = 'slot' | 'legacy-home' | 'provisioned';

export interface NativeSpawnHome {
  execHome: string;
  source: SpawnHomeSource;
  slot?: DeviceAccountSlot;
}

export function isAccountSlotDir(dir: string): boolean {
  const root = path.resolve(getHistoryDir(), 'accounts');
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function missingSlotHint(agent: AgentId, name: string): string {
  const role = selfConfiguredDeviceRole();
  if (!isHeadedDeviceRole(role)) {
    return `${agent}#${name} has no slot on this device. `
      + `Add the account on your personal device with \`agents accounts add ${agent} ${name}\`; `
      + `workers are provisioned from the durable credential automatically `
      + `(${agent}: ${workerProvisioningHint(agent)}).`;
  }
  return `${agent}#${name} has no slot on this device. Sign in with: agents accounts login ${agent}#${name}`;
}

export function symlinkAdoptedAccountError(agent: AgentId, name: string, defaultName: string | undefined): string {
  if (!defaultName) {
    return `${agent} holds one active account per device (adopted ~/.<config> symlink). `
      + `Set the default first: agents accounts default ${agent} ${name}`;
  }
  return `${agent} holds one active account per device (adopted ~/.<config> symlink). `
    + `'${name}' is not the default ('${defaultName}'). `
    + `Switch with: agents accounts default ${agent} ${name}`;
}

function nativeRow(accountId: string, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount | undefined {
  return listNativeAccounts(meta).find((row) => row.id === accountId);
}

function isProvisionableWorker(account: NativeAccount): boolean {
  if (isHeadedDeviceRole(selfConfiguredDeviceRole())) return false;
  const durable = harnessWorkerKinds(account.agent).some(
    (kind) => kind === 'setup-token' || kind.startsWith('api-key'),
  );
  if (!durable) return false;
  if (account.workerCredential) {
    return readReservedCredential(account.workerCredential.bundle, account.workerCredential.key) != null;
  }
  // Pre-T1 Claude rows key the legacy `auth` bundle by email.
  if (account.agent === 'claude' && account.identityLabel) {
    return readReservedCredential(AUTH_BUNDLE, claudeAccountTokenKey(account.identityLabel)) != null;
  }
  return false;
}

/**
 * Resolve the spawn HOME for a native account on THIS device.
 * Prefers a slot dir that exists on disk; else a leftover `homes` installation
 * label; else T6 worker provisioning when the durable key is here.
 */
export function resolveNativeSpawnHome(
  agent: AgentId,
  account: { id: string; name: string; agent: AgentId },
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = { accounts: undefined, deviceAccounts: undefined },
): NativeSpawnHome {
  const slot = readSlots(meta)[account.id];
  if (slot && fs.existsSync(slot.slotDir)) {
    return { execHome: slot.slotDir, source: 'slot', slot };
  }

  const label = nativeAccountHome(account.id, meta);
  if (label) {
    const legacyHome = getVersionHomePath(agent, label);
    if (fs.existsSync(legacyHome)) {
      return { execHome: legacyHome, source: 'legacy-home' };
    }
  }

  const row = nativeRow(account.id, meta);
  if (row && isProvisionableWorker(row)) {
    const provisioned = provisionWorkerSlot(row);
    return { execHome: provisioned.slotDir, source: 'provisioned', slot: provisioned };
  }

  throw new Error(missingSlotHint(agent, account.name));
}
