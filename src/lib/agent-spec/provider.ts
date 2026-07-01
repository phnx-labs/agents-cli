// The production VersionProvider: the only fs/meta-coupled file in the engine.
// Everything else in this module is pure and testable without it.

import {
  listInstalledVersions,
  getGlobalDefault,
  getProjectVersion,
  isVersionInstalled,
} from '../versions.js';
import type { VersionProvider } from './types.js';

export const defaultVersionProvider: VersionProvider = {
  listInstalled: (agent) => listInstalledVersions(agent),
  getProjectVersion: (agent, cwd) => getProjectVersion(agent, cwd),
  getGlobalDefault: (agent) => getGlobalDefault(agent),
  isInstalled: (agent, version) => isVersionInstalled(agent, version),
};
