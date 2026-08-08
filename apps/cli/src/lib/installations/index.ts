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
  INSTALLATION_RECORD_FILE,
  INSTALLATION_SCHEMA,
  type Installation,
  type InstallationRelease,
  type UpdateOutcome,
  type UpdateStrategyId,
} from './types.js';

export {
  createInstallation,
  ensureInstallation,
  installationDir,
  installationRecordPath,
  listInstallationLabels,
  listInstallations,
  mintInstallationId,
  readInstallation,
  recordRelease,
  writeInstallation,
} from './store.js';

export {
  InstallationAmbiguousError,
  InstallationNotFoundError,
  describeInstallation,
  resolveInstallation,
  type ResolveInstallationOptions,
} from './resolve.js';

export {
  assertValidRelease,
  selectUpdateStrategy,
  supportsPinnedUpdate,
  type UpdateStrategy,
} from './strategies.js';

export { updateInstallation, type UpdateInstallationOptions } from './update.js';
