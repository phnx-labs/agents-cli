import * as path from 'path';

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
