// Anti-drift guard for the CLI registry snapshot (agents.cli.ts).
//
// The extension cannot import the CLI in-process (no JS workspaces; ESM vs
// CommonJS), so agents.cli.ts mirrors the registry as a checked-in snapshot.
// These tests read the CLI's real source files from the monorepo checkout and
// fail when the snapshot drifts — an agent added to apps/cli must land here in
// the same change. Real files, no mocks.

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CLI_AGENT_IDS, CLI_AGENT_META } from './agents.cli';

const CLI_LIB = path.resolve(__dirname, '..', '..', '..', 'cli', 'src', 'lib');

// A packaged source tree without apps/cli (e.g. an extension-only checkout)
// has nothing to diff against — the guard only runs inside the monorepo.
const inMonorepo = fs.existsSync(path.join(CLI_LIB, 'types.ts'));

(inMonorepo ? describe : describe.skip)('agents.cli snapshot vs apps/cli source', () => {
  test('CLI_AGENT_IDS matches the AgentId union in apps/cli/src/lib/types.ts', () => {
    const src = fs.readFileSync(path.join(CLI_LIB, 'types.ts'), 'utf-8');
    const union = src.match(/export type AgentId =([^;]+);/);
    expect(union).toBeTruthy();
    const ids = [...union![1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect([...CLI_AGENT_IDS].sort()).toEqual([...ids].sort());
  });

  test('CLI_AGENT_META name/cliCommand match the AGENTS table in apps/cli/src/lib/agents.ts', () => {
    const src = fs.readFileSync(path.join(CLI_LIB, 'agents.ts'), 'utf-8');
    for (const [id, meta] of Object.entries(CLI_AGENT_META)) {
      // Each entry opens at 2-space indent (`  claude: {`) and closes with the
      // first `  },` back at that indent; nested objects sit deeper.
      const entry = src.match(new RegExp(`\\n  ${id}: \\{([\\s\\S]*?)\\n  \\}`));
      expect(entry, `AGENTS table entry for '${id}'`).toBeTruthy();
      const body = entry![1];
      const name = body.match(/\bname: '([^']*)'/);
      const cliCommand = body.match(/\bcliCommand: '([^']*)'/);
      expect(name?.[1], `name for '${id}'`).toBe(meta.name);
      expect(cliCommand?.[1], `cliCommand for '${id}'`).toBe(meta.cliCommand);
    }
  });
});
