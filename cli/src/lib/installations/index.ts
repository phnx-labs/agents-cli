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
} from './types.js';

export {
  createInstallation,
  listInstallations,
  recordRelease,
} from './store.js';

export {
  describeInstallation,
  resolveInstallation,
  type ResolveInstallationOptions,
} from './resolve.js';

export {
  selectUpdateStrategy,
  supportsPinnedUpdate,
  type UpdateStrategy,
} from './strategies.js';

export { updateInstallation, type UpdateInstallationOptions } from './update.js';
