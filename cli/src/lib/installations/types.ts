import type { AgentId } from '../types.js';

/**
 * Schema version of the on-disk installation record. Bump only for a change a
 * previous CLI could not read; {@link INSTALLATION_SCHEMA} is asserted on read
 * so a newer record fails loud instead of being silently misinterpreted.
 */
export const INSTALLATION_SCHEMA = 1;

/** File name of the record, written at the root of a version dir. */
export const INSTALLATION_RECORD_FILE = 'installation.json';

/**
 * One entry in an installation's release history — appended on every successful
 * update so `agents update --json` can report where a frozen installation came
 * from without consulting the vendor.
 */
export interface InstallationRelease {
  /** The vendor release that was live for this span. */
  releaseVersion: string;
  /** ISO-8601 timestamp at which this release became live. */
  at: string;
}

/**
 * A frozen agent installation.
 *
 * The load-bearing idea: an installation's IDENTITY ({@link id}, {@link label})
 * is stable for the life of the install, while the vendor release it carries
 * ({@link releaseVersion}) moves only on an explicit `agents update`. Every
 * persisted reference — the global default, an isolated default, a project pin,
 * a routine's agent spec — names the {@link label}, so a release change never
 * invalidates a reference.
 *
 * Before this record existed the version-dir NAME was the only identity, which
 * made those two concepts the same string: updating a release necessarily
 * renamed the directory and broke every reference pointing at it, and two
 * installations of the same release could not coexist at all. Splitting them is
 * what makes both possible.
 */
export interface Installation {
  schema: number;
  /** Opaque, stable, never reused. Survives every update. */
  id: string;
  agent: AgentId;
  /**
   * The addressable name of this installation — the version-dir basename, and
   * the token users type in `agents update <agent>@<label>`. Frozen at creation.
   */
  label: string;
  /** The vendor release currently installed on disk. Moves on update. */
  releaseVersion: string;
  createdAt: string;
  updatedAt: string;
  /** Newest last. Always non-empty: creation seeds it with the first release. */
  history: InstallationRelease[];
}

/**
 * How an installation's release is replaced. Selected from the agent registry's
 * capabilities, never from an agent id — see `selectUpdateStrategy`.
 */
export type UpdateStrategyId =
  /** Agent ships an npm package: a pinnable release staged into the version dir. */
  | 'npm-package'
  /** One global self-updating binary shared by every installation of the agent. */
  | 'global-binary'
  /** An official install script with no pinnable version, re-imported per install. */
  | 'install-script';

/** Outcome of a single `agents update` run against one installation. */
export interface UpdateOutcome {
  installation: Installation;
  strategy: UpdateStrategyId;
  fromRelease: string;
  toRelease: string;
  /** True when the resolved target already matched the installed release. */
  unchanged: boolean;
  /**
   * Installations other than the target whose recorded release also moved,
   * because the strategy replaced a binary they share (global-binary only).
   */
  alsoUpdated: Installation[];
}
