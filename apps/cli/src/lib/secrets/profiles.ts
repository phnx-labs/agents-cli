/**
 * Thin compatibility shim over the shared secrets library.
 *
 * Profile tokens are stored at `agents-cli.<provider>.token`; secrets bundles
 * live at `agents-cli.secrets.<bundle>.<KEY>`. Both go through the same
 * keychain primitives in ./index.ts.
 */
export {
  hasKeychainToken,
  getKeychainToken,
  setKeychainToken,
  deleteKeychainToken,
} from './index.js';
import { profileKeychainItem } from './index.js';

/** Map a provider name to its keychain item identifier. */
export function keychainItemName(provider: string): string {
  return profileKeychainItem(provider);
}
