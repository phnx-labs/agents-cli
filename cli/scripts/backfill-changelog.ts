// One-time migration: split the monolithic CHANGELOG.md into per-version files
// under `.changelog/`, and seed the release queue with the current Unreleased
// content. Idempotent — re-running overwrites the same files deterministically.
//
// After running this, run `bun scripts/gen-changelog.ts` and diff the regenerated
// CHANGELOG.md against the original to confirm a faithful round-trip.
//
// Run: `bun scripts/backfill-changelog.ts`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(cliRoot, 'CHANGELOG.md'), 'utf-8');

type Section = { title: string; body: string[] };
const sections: Section[] = [];
let current: Section | null = null;
for (const line of src.split('\n')) {
  if (line === '# Changelog') continue;
  const m = /^## (.+?)\s*$/.exec(line);
  if (m) {
    current = { title: m[1], body: [] };
    sections.push(current);
    continue;
  }
  if (current) current.body.push(line);
}

const changelogDir = join(cliRoot, '.changelog');
const nextDir = join(changelogDir, 'next');
mkdirSync(nextDir, { recursive: true });

let versionCount = 0;
for (const s of sections) {
  const body = `${s.body.join('\n').trim()}\n`;
  if (s.title === 'Unreleased') {
    // Seed the queue: the pending Unreleased note ships in the next release.
    if (body.trim()) writeFileSync(join(nextDir, 'fleet-apply.md'), body);
  } else {
    writeFileSync(join(changelogDir, `${s.title}.md`), body);
    versionCount++;
  }
}

console.log(`backfill: wrote ${versionCount} version files + seeded queue into ${changelogDir}`);
