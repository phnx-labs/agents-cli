import * as yaml from 'yaml';

/**
 * The single serialization used by every writer that edits a shared, committed
 * YAML document in place.
 *
 * RUSH-2505 had two halves. The first: the `yaml` emitter pads flow collections
 * by default, so a round trip rewrote
 *
 *     command: [agents, notify, "{message}"]
 * as
 *     command: [ agents, notify, "{message}" ]
 *
 * The second, which outlived the first fix: `agents.yaml` has five in-place
 * writers, and they did not agree on collection style. `state.ts` and
 * `manifest.ts` forced block while `feed.ts`, `activity.ts` and `migrate.ts`
 * took the defaults, so an empty map came out as
 *
 *     mcp:            from two of them, and      mcp: {}
 *       {}                                        from the other three,
 *
 * and each group rewrote the other's output on the next command.
 *
 * Both diffs are semantically no-ops, which is what made them dangerous. The
 * working tree went permanently dirty, then `agents repo pull` refused
 * ("Blocked by local changes") and `git merge --ff-only` refused, so the box
 * silently stopped receiving fleet config. Seven boxes fell 37-52 commits
 * behind and nothing reported it.
 *
 * Two constraints pull in opposite directions, and both are real:
 *
 *  - Forcing `collectionStyle: 'block'` unconditionally flattens a committed
 *    flow sequence into a block list — its own dirtying diff, asserted against
 *    by the RUSH-2505 case in `feed.test.ts`.
 *  - Never forcing it regresses what `state.ts` and `manifest.ts` were guarding:
 *    when the document ROOT is flow (a legacy `{}` or `{a: 1}` file), every
 *    edited node inherits flow, so a `doc.set()` yields
 *    `{a: 1, disabledCommands: [teams]}` instead of a block mapping.
 *
 * So block is forced exactly when the root is flow, which is the only case that
 * needs it, and left alone otherwise. Every writer gets the same rule, so the
 * same document can only produce one result and there is nothing left to
 * oscillate.
 *
 * Caller options merge last, so a writer with a genuine reason to differ still
 * can — but it then owns the drift it causes.
 */
export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  // A flow root makes every edited node render flow; normalize the whole doc to
  // block in that case only. `contents.flow` is undefined for a block root.
  const rootIsFlow = (doc.contents as { flow?: boolean } | null)?.flow === true;
  return doc.toString({
    flowCollectionPadding: false,
    ...(rootIsFlow ? { collectionStyle: 'block' as const } : {}),
    ...options,
  });
}
