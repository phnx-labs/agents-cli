/**
 * `lib/storage` — the surface-agnostic core the managed-storage surfaces share:
 *
 *   - {@link selection}  the ONE managed-vs-BYO selection policy.
 *   - {@link visibility} the ONE visibility model + product default (`me`).
 *
 * Consume the SELECTION + VISIBILITY POLICY from here; keep each surface's typed,
 * `kind`-tagged backend adapter (endpoint, namespace, covers) in that surface's
 * own module. `agents artifacts share` (`lib/share/`) and `agents traces`
 * (`lib/traces/`) are the two current adapters; the `sessions` sync adapter is
 * the next consumer.
 */

export {
  type StorageBackendKind,
  type StorageSelectionOpts,
  selectStorageBackendKind,
  isManagedSelection,
} from './selection.js';

export {
  type ShareVisibility,
  type VisibilityFlags,
  PUBLISH_VISIBILITY_LEVELS,
  EDITABLE_VISIBILITY_LEVELS,
  MANAGED_DEFAULT_VISIBILITY,
  BYO_DEFAULT_VISIBILITY,
  defaultVisibilityForBackend,
  explicitVisibility,
  resolveVisibility,
  publishVisibility,
} from './visibility.js';
