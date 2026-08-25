/**
 * Debug logging for the teams module.
 *
 * Outputs to stderr when AGENTS_DEBUG or DEBUG environment variables are set.
 */

const ENABLED = Boolean(process.env.AGENTS_DEBUG || process.env.DEBUG);

/** Log debug messages to stderr when debug mode is enabled. */
export function debug(...args: unknown[]): void {
  if (ENABLED) console.error(...args);
}
