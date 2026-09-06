/**
 * Frozen agent installations.
 *
 * An installation's identity (`id`, `label`) is stable for its whole life; the
 * vendor release it carries moves only on an explicit `agents update`. This
 * barrel is the supported surface — import from here, not from the files behind
 * it, so the internal split can change without breaking callers (the Cursor
 * per-installation isolation track consumes exactly this).
 */

export {
  type Installation,
  type InstallationRelease,
  type UpdateOutcome,
  type UpdateStrategyId,
  type UpdatePolicy,
} from './types.js';

export {
  createInstallation,
  installedReleaseFor,
  listInstallations,
  recordRelease,
} from './store.js';

export {
  describeInstallation,
  describeInstalledLabel,
  resolveInstallation,
  type ResolveInstallationOptions,
} from './resolve.js';

export {
  selectUpdateStrategy,
  supportsPinnedUpdate,
  type UpdateStrategy,
} from './strategies.js';

export { updateInstallation, type UpdateInstallationOptions } from './update.js';

export {
  effectiveUpdatePolicy,
  isAutoUpdateEnabledForAgent,
  isGlobalAutoUpdateEnabled,
  rawAgentAutoUpdateSetting,
  rawGlobalAutoUpdateSetting,
  setAgentAutoUpdateEnabled,
  setGlobalAutoUpdateEnabled,
  setInstallationUpdatePolicy,
  unsetAgentAutoUpdateEnabled,
  unsetGlobalAutoUpdateEnabled,
} from './update-policy.js';

export {
  planAutoUpdates,
  runAutoUpdatePass,
  listInstallationSnapshots,
  type AutoUpdatePlanEntry,
  type AutoUpdatePassOutcome,
  type AutoUpdatePassOptions,
  type AutoUpdatePassResult,
} from './update-runtime.js';

export {
  installationLooksActive,
  isInstallationLikelyActive,
  realProcessSnapshot,
  type ProcessSnapshot,
} from './active-check.js';

export { recordLaunchLease, hasLiveLaunchLease } from './shims.js';
