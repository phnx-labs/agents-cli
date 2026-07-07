import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, writeExecFile,
  build, isStale,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

describe('staleness e2e: integration', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('integ'); });
  afterEach(()  => fx.cleanup());

  it('full populated tree across all resource types: build -> clean -> mutate any one -> stale', () => {
    // Commands
    writeFile(fx, 'system', 'commands/foo.md', 'foo');
    writeFile(fx, 'user',   'commands/bar.md', 'bar');
    // Skills
    writeFile(fx, 'user',   'skills/my-skill/SKILL.md', 'skill');
    // Hooks (executable)
    writeExecFile(fx, 'system', 'hooks/00-check.sh', '#!/bin/bash');
    // MCP
    writeFile(fx, 'user',   'mcp/server.yaml', 'name: srv\ntransport: stdio\ncommand: echo hi\n');
    // Subagents
    writeFile(fx, 'project', 'subagents/helper/AGENT.md', '---\nname: helper\n---\nbody');
    // Workflows
    writeFile(fx, 'user',   'workflows/wf/WORKFLOW.md', 'wf');
    // Plugins
    writeFile(fx, 'user',   'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg","version":"1.0.0"}');
    // Permissions
    writeFile(fx, 'system', 'permissions/groups/base.yaml', 'allow:\n  - Bash(ls)\n');
    // Rules
    writeFile(fx, 'system', 'rules/rules.yaml',       'presets:\n  default:\n    subrules:\n      - core\n');
    writeFile(fx, 'system', 'rules/subrules/core.md', 'core');

    build(fx);
    expect(isStale(fx)).toBe(false);

    // Touch a single resource type at a time; each should produce stale=true.
    const mutations: Array<[string, () => void]> = [
      ['commands',    () => writeFile(fx, 'user',   'commands/new.md', 'new')],
      ['skills',      () => fs.writeFileSync(path.join(fx.userDir, 'skills/my-skill/SKILL.md'), 'modified')],
      ['hooks',       () => writeExecFile(fx, 'user', 'hooks/new.sh', '#!/bin/bash')],
      ['mcp',         () => writeFile(fx, 'user',   'mcp/server.yaml', 'name: srv\ntransport: stdio\ncommand: echo hi --flag\n')],
      ['subagents',   () => fs.writeFileSync(path.join(fx.projectAgents, 'subagents/helper/AGENT.md'), '---\nname: helper\n---\nchanged')],
      ['workflows',   () => fs.writeFileSync(path.join(fx.userDir, 'workflows/wf/WORKFLOW.md'), 'wf-v2')],
      ['plugins',     () => writeFile(fx, 'user', 'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg","version":"2.5.99-rc1"}')],
      ['permissions', () => writeFile(fx, 'system', 'permissions/groups/base.yaml', 'allow:\n  - Bash(ls -la)\n')],
      ['rules',       () => writeFile(fx, 'system', 'rules/subrules/core.md', 'core-v2')],
    ];

    for (const [label, mutate] of mutations) {
      build(fx);
      expect(isStale(fx), `expected clean after rebuild for ${label}`).toBe(false);
      mutate();
      expect(isStale(fx), `expected stale after mutating ${label}`).toBe(true);
    }
  });

  // ─── Bug regression tests (cf. the v1 sync-manifest bugs) ────────────────

  it('regression #1: rules section is actually tracked (was always-stale before fix)', () => {
    // Pre-fix: `available.memory` was preset names, manifest tracked
    // `rules/<preset>.md` paths that never existed -> empty manifest -> always stale.
    writeFile(fx, 'system', 'rules/rules.yaml',       'presets:\n  default:\n    subrules:\n      - core\n');
    writeFile(fx, 'system', 'rules/subrules/core.md', 'core');
    build(fx);
    expect(isStale(fx)).toBe(false); // pre-fix would have returned true here
  });

  it('regression #2: hook manifest matches the sync writer (excludes project layer)', () => {
    // Pre-fix: hook manifest fingerprinted project, sync wrote user. After
    // fix, both ignore project — a project hook with the same name as a
    // user hook does NOT affect the manifest at all.
    writeExecFile(fx, 'user',    'hooks/same.sh', '#!/bin/bash\necho user');
    build(fx);
    writeExecFile(fx, 'project', 'hooks/same.sh', '#!/bin/bash\necho project');
    expect(isStale(fx)).toBe(false);
  });

  it('regression #3: project subagent does not break the name-set diff', () => {
    // Pre-fix: `available.subagents` included project subagents but the
    // manifest map was built from listInstalledSubagents() (user+system
    // only) -> sets disagreed -> always stale.
    writeFile(fx, 'project', 'subagents/proj-only/AGENT.md', '---\nname: x\n---\n');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('regression #4: workflows + plugins are tracked at all (not in v1 manifests)', () => {
    writeFile(fx, 'user', 'workflows/wf/WORKFLOW.md',  'wf');
    writeFile(fx, 'user', 'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg"}');
    build(fx);
    expect(isStale(fx)).toBe(false);
    fs.writeFileSync(path.join(fx.userDir, 'workflows/wf/WORKFLOW.md'), 'wf-v2');
    expect(isStale(fx)).toBe(true);
  });

  it('manifest is JSON-round-trippable (load -> save -> load yields identical content)', () => {
    writeFile(fx, 'user',   'commands/foo.md', 'foo');
    writeFile(fx, 'user',   'skills/s/SKILL.md', 'skill');
    writeExecFile(fx, 'user', 'hooks/h.sh', '#!/bin/bash');
    const m1 = build(fx);
    // build also saves; isStale loads it. If the load+save round-trip is
    // broken, isStale will see no manifest (or the wrong shape) and report
    // stale=true even though the tree hasn't changed.
    expect(isStale(fx)).toBe(false);
    expect(m1.v).toBe(1);
    expect(Object.keys(m1.commands)).toEqual(['foo']);
  });
});
