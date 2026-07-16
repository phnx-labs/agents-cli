// Generate the aggregate CHANGELOG.md from the per-version `.changelog/` directory.
//
// Source of truth is `.changelog/`:
//   .changelog/<version>.md   one file per SHIPPED version (bullets only, no heading)
//   .changelog/next/<slug>.md one file per merged-but-unreleased PR (the queue)
//
// The aggregate `CHANGELOG.md` is a GENERATED artifact — never hand-edit it.
// It is regenerated at release time (release.sh) and shipped in the npm tarball,
// so `agents upgrade`'s "what's new" (index.ts -> unpkg) keeps working unchanged.
//
// It contains RELEASED versions only. The unreleased queue lives in
// `.changelog/next/` and is folded in at release time (release-changelog.ts) —
// deliberately NOT rendered here, so adding a queue fragment never touches the
// aggregate and can never reintroduce a merge hot-spot.
//
// Ordering reuses the CLI's own `compareVersions` (zero-dep, agent-spec/primitives)
// so the changelog sorts versions exactly like every other version-aware surface.
//
// Run: `bun scripts/gen-changelog.ts` (or `npm run changelog`).

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/lib/agent-spec/primitives';

/** A version filename is `X.Y[.Z][-pre.N].md` — starts with a digit. */
const VERSION_FILE = /^\d[\w.+-]*\.md$/;

/**
 * Assemble the aggregate body from parsed version sections, newest-first. Pure
 * (no I/O) so the sort order is unit-testable. Released versions only — the
 * unreleased queue is never rendered here (see file header).
 */
export function buildAggregate(versions: { version: string; body: string }[]): string {
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  const sections = sorted.map((v) => `## ${v.version}\n\n${v.body.trim()}`);
  return `# Changelog\n\n${sections.join('\n\n')}\n`;
}

/** Read the released per-version files from `.changelog/` and produce the aggregate. */
export function generate(changelogDir: string): string {
  const versions: { version: string; body: string }[] = [];
  for (const name of readdirSync(changelogDir)) {
    if (!VERSION_FILE.test(name)) continue; // skips `next/`, README, dotfiles
    const full = join(changelogDir, name);
    if (!statSync(full).isFile()) continue;
    versions.push({ version: name.slice(0, -3), body: readFileSync(full, 'utf-8') });
  }
  return buildAggregate(versions);
}

// CLI entry — only when executed directly (bun sets import.meta.main; under
// vitest/node it is falsy, so importing buildAggregate/generate has no side effect).
if ((import.meta as { main?: boolean }).main) {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = generate(join(cliRoot, '.changelog'));
  writeFileSync(join(cliRoot, 'CHANGELOG.md'), out);
  console.log(`gen-changelog: wrote CHANGELOG.md (${out.length} bytes)`);
}
