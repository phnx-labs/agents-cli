import * as fs from 'fs';
import * as path from 'path';

/**
 * Canonicalize `target` by `realpath`-resolving its longest EXISTING ancestor and
 * re-appending the not-yet-created tail. A plain `realpathSync(target)` throws when
 * `target` (a fresh output dir, a not-yet-written file) does not exist — but any
 * symlink in the part that DOES exist (the target itself, or an ancestor) is
 * exactly the escape hatch a containment check must resolve before comparing.
 * Unlike `path.resolve` (which only normalizes `..`), this follows links.
 */
export function realpathExistingPrefix(target: string): string {
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
 * Whether THIS platform's filesystem resolves path identity case-insensitively
 * (and, on the same platforms, Unicode-normalization-insensitively) — the macOS
 * and Windows default, but NOT Linux. Two paths differing only by letter case or
 * Unicode normalization form name the SAME file where this is true and DISTINCT
 * files where it is false, so an identity/containment check MUST fold both here
 * and MUST NOT on Linux — where `~/.Claude` and `~/.claude`, or an NFC vs NFD
 * spelling, are genuinely different directories and folding would over-reject a
 * legitimate output home. Keyed on platform rather than a live probe because the
 * comparison happens on paths that do not exist yet (a fresh output home, the
 * absent target of a dangling symlink), so there is nothing to stat; a
 * case-insensitive Linux mount is rare and the safe direction there is the
 * case-sensitive default. Overridable per call for tests, since CI is Linux.
 */
export const FS_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Fold `p` to the key two spellings share IFF they name the same file on a
 * case-insensitive filesystem: Unicode-normalize to NFC (so an NFC and NFD
 * spelling of the same name collapse) and lowercase. On a case-sensitive
 * platform the path is returned verbatim — neither case nor normalization form
 * is unified, preserving Linux's exact-byte path identity.
 */
export function pathIdentityKey(p: string, caseInsensitive: boolean = FS_CASE_INSENSITIVE): string {
  return caseInsensitive ? p.normalize('NFC').toLowerCase() : p;
}

/**
 * True when `child` IS `parent` or lies strictly inside it, comparing with the
 * platform's real path-identity semantics (case- and normalization-insensitive
 * on macOS/Windows, exact on Linux). Both arguments must already be absolute /
 * `path.resolve`-normalized. This is the canonical containment predicate a
 * boundary check must use instead of a raw `===` / `startsWith`, which silently
 * accepts a spelling-equivalent alias on a case-insensitive filesystem (PHNX-3838).
 */
export function pathIsWithin(parent: string, child: string, caseInsensitive: boolean = FS_CASE_INSENSITIVE): boolean {
  const p = pathIdentityKey(parent, caseInsensitive);
  const c = pathIdentityKey(child, caseInsensitive);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * True when `name` is a safe single path segment: non-empty, not '.'/'..',
 * free of path separators and null bytes, and within the filename length limit.
 * Dot-prefixed names like '.env.example' are allowed.
 */
export function isSafeSegmentName(name: string): boolean {
  return (
    !!name &&
    name !== '.' && name !== '..' &&
    !/[\/\\\x00]/.test(name) &&
    name.length <= 255
  );
}

/**
 * Resolve base + name while preventing path-traversal attacks.
 * Rejects path separators, null bytes, '.' and '..', and any resolved path
 * that escapes the base directory. Dot-prefixed names like '.env.example'
 * are allowed — actual traversal is caught by the containment check below.
 * Allows spaces, unicode, and other common filename characters.
 */
export function safeJoin(base: string, name: string): string {
  if (!isSafeSegmentName(name)) {
    throw new Error(`Invalid name: ${name}`);
  }
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}

/**
 * Assert that `target` (which may legitimately contain path separators, e.g. a
 * multi-segment relative key) stays within `root` after normalization. Use this
 * where a caller must accept nested relative paths but the input is untrusted —
 * `safeJoin` is stricter and only allows single segments.
 */
export function assertWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escape: ${target}`);
  }
  return resolved;
}
