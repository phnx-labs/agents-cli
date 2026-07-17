/**
 * Poll source evaluator.
 *
 * `poll` re-runs a shell command on an interval and diffs the output. The
 * evaluation is identical to the `command` source — the difference is only the
 * scheduling cadence (source.interval), which the engine owns — so this
 * delegates to command.ts rather than duplicating the shell-run.
 */

export { evaluate } from './command.js';
