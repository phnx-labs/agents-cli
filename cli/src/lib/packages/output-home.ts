/**
 * Front-door safety guard for `agents packages materialize` (PHNX-3838).
 *
 * The canonical materializer ({@link materializeAgentPackage} in
 * `agent-spec/materialize.ts`) writes into whatever `outputHome` it is handed —
 * that is its job, and it must stay destination-agnostic so Factory / Prix Cloud
 * can point it at any ephemeral home. Refusing a *dangerous* destination is a
 * CLI-front-door concern, not a materializer concern, so it lives here:
 *
 *   - the target may not climb out of cwd (relative) or carry a `..` segment;
 *   - the target may not be the operator's live home ROOT, nor — or sit inside —
 *     the live `~/.claude`, `~/.codex`, or `~/.opencode` home;
 *   - the harness must be one of the three portable homes;
 *   - the harness version must be an exact version, never `@latest`.
 *
 * The live-home ROOT refusal is load-bearing: the materializer appends the
 * harness config dir (`.claude`/`.codex`/`.opencode`) to `outputHome`, so an
 * `outputHome` of `$HOME` itself would land straight in the operator's live
 * `~/.claude`. And because a symlink (`outputHome` itself, or any ancestor)
 * pointing at `$HOME` re-opens the same hole — `path.resolve` normalizes `..`
 * but never follows links — the check canonicalizes the existing ancestors with
 * `realpath` before comparing.
 *
 * Kept beside the command (not inside it) so the live-home refusal is
 * unit-testable without spawning the whole CLI.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertWithin } from '../paths.js';
import { VERSION_RE } from '../agent-spec/primitives.js';

/** The three harness homes a portable schema-v3 package can be materialized into. */
export const PORTABLE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type PortableHarness = (typeof PORTABLE_HARNESSES)[number];

export function isPortableHarness(value: string): value is PortableHarness {
  return (PORTABLE_HARNESSES as readonly string[]).includes(value);
}

/** Thrown for a bad front-door argument (harness / version / output home). Never `process.exit`. */
export class MaterializeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeGuardError';
  }
}

/** Reject a harness that is not one of the three portable homes, with a message naming it. */
export function assertPortableHarness(harness: string): PortableHarness {
  if (!isPortableHarness(harness)) {
    throw new MaterializeGuardError(
      `Unsupported capability: '${harness}' is not a portable-agent harness (${PORTABLE_HARNESSES.join(', ')}).`,
    );
  }
  return harness;
}

/** Reject a non-exact harness version (empty, malformed, or `@latest`). */
export function assertExactHarnessVersion(version: string): string {
  if (!version || version === 'latest' || !VERSION_RE.test(version)) {
    throw new MaterializeGuardError(
      `Invalid harness version '${version}'. Pass an exact harness version (not @latest).`,
    );
  }
  return version;
}

/** True when `raw` still contains a `..` segment after splitting on both separators. */
export function outputHomeHasDotDot(raw: string): boolean {
  return raw.split(/[\\/]/).includes('..');
}

function liveHarnessHomes(home: string): string[] {
  return PORTABLE_HARNESSES.map((name) => path.join(home, `.${name}`));
}

/**
 * Canonicalize `target` by `realpath`-resolving its longest EXISTING ancestor and
 * re-appending the not-yet-created tail. `outputHome` is usually a fresh dir that
 * does not exist yet, so a plain `realpathSync(target)` would throw — but any
 * symlink in the part that DOES exist (the target itself, or an ancestor) is
 * exactly the escape hatch we must resolve before comparing to the live homes.
 */
function canonicalizeExistingAncestors(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // nothing on this path exists
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `--output-home` to an absolute path, refusing a target that climbs out
 * of cwd (relative), uses a `..` segment, IS the live home root, or targets (or
 * sits inside) a live Claude/Codex/OpenCode home — after canonicalizing symlinks
 * in the existing ancestors so a symlinked target/ancestor can't alias `$HOME`.
 * Every rejection carries a `Path escape:` prefix so callers surface one
 * consistent reason.
 */
export function resolveOutputHome(raw: string, cwd = process.cwd(), home = os.homedir()): string {
  if (!raw || raw.includes('\0')) {
    throw new MaterializeGuardError('Path escape: output home is empty or contains a null byte');
  }
  if (outputHomeHasDotDot(raw)) {
    throw new MaterializeGuardError(`Path escape: ${raw}`);
  }
  const resolved = path.resolve(cwd, raw);
  if (!path.isAbsolute(raw)) {
    try {
      assertWithin(cwd, resolved);
    } catch {
      throw new MaterializeGuardError(`Path escape: ${raw}`);
    }
  }
  const canonical = canonicalizeExistingAncestors(resolved);
  const realHome = canonicalizeExistingAncestors(home);
  // The materializer appends the harness config dir to outputHome, so the live
  // home ROOT would write straight into ~/.claude etc.
  if (canonical === realHome) {
    throw new MaterializeGuardError('Path escape: output home must not be the live home directory');
  }
  for (const live of liveHarnessHomes(realHome)) {
    if (canonical === live || canonical.startsWith(live + path.sep)) {
      throw new MaterializeGuardError(
        `Path escape: output home must not target the live ${path.basename(live)} directory`,
      );
    }
  }
  return resolved;
}
