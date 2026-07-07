/**
 * Platform abstraction — the ONE place OS-divergent behavior is decided.
 *
 * Consumers express intent (`looksLikePath`, `findExecutable`, `isAlive`) instead
 * of scattering `process.platform === 'win32'` checks. Each helper that has an
 * observable branch accepts an explicit `platform` argument (defaulting to
 * `process.platform`), so all three OSes are unit-testable on any host.
 *
 * Modules grow per concern as features land:
 *   paths   — path classification + normalization
 *   exec    — executable resolution
 *   process — process liveness / control
 * (ipc + shell follow when their consumers migrate off inline branches.)
 */
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export * from './paths.js';
export * from './exec.js';
export * from './links.js';
export * from './process.js';
export * from './ipc.js';
export * from './winpath.js';
