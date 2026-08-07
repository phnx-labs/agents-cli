// Exercises the real command tree (no mocks) so a Commander upgrade that renames
// the introspection API (`registeredArguments`, `.aliases()`, `.options`) — or a
// command that stops registering — fails here instead of silently producing an
// empty/wrong index.

import { describe, expect, it } from 'vitest';
import { buildFullCommandTree } from '../src/lib/startup/command-registry.js';
import {
  argToken,
  countCommands,
  invocation,
  renderJson,
  renderMarkdown,
  walk,
  type CommandNode,
} from './gen-command-index';

async function tree(): Promise<CommandNode[]> {
  return walk(await buildFullCommandTree());
}

function find(nodes: CommandNode[], path: string): CommandNode | undefined {
  const parts = path.split(' ');
  let level = nodes;
  let node: CommandNode | undefined;
  for (const part of parts) {
    node = level.find((n) => n.name === part);
    if (!node) return undefined;
    level = node.subcommands;
  }
  return node;
}

describe('argToken', () => {
  it('renders required/optional/variadic usage tokens', () => {
    expect(argToken({ name: 'id', required: true, variadic: false })).toBe('<id>');
    expect(argToken({ name: 'query', required: false, variadic: false })).toBe('[query]');
    expect(argToken({ name: 'specs', required: true, variadic: true })).toBe('<specs...>');
    expect(argToken({ name: 'rest', required: false, variadic: true })).toBe('[rest...]');
  });
});

describe('command index generation', () => {
  it('builds a non-trivial tree from the real command modules', async () => {
    const nodes = await tree();
    expect(nodes.length).toBeGreaterThan(50); // the whole tree really loaded
    expect(countCommands(nodes)).toBeGreaterThan(nodes.length); // groups have subcommands
  });

  it('captures a nested command with its required argument (teams create <team>)', async () => {
    const nodes = await tree();
    const create = find(nodes, 'teams create');
    expect(create).toBeDefined();
    expect(create!.args).toContainEqual({ name: 'team', required: true, variadic: false });
    expect(invocation(create!)).toBe('teams create <team>');
    expect(create!.description.length).toBeGreaterThan(0);
  });

  it('records commander aliases without duplicating the group (devices/fleet)', async () => {
    const nodes = await tree();
    // `fleet` is an alias of `devices`, so it must NOT appear as its own group.
    expect(nodes.filter((n) => n.name === 'fleet')).toHaveLength(0);
    expect(find(nodes, 'devices')?.aliases).toContain('fleet');
  });

  it('excludes the inline aliases/tombstones registered in src/index.ts', async () => {
    const nodes = await tree();
    const names = new Set(nodes.map((n) => n.name));
    for (const inline of ['perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', 'upgrade', '_internal']) {
      expect(names.has(inline)).toBe(false);
    }
  });

  it('captures option flags in the JSON tree', async () => {
    const nodes = await tree();
    const json = JSON.parse(renderJson(nodes)) as { tree: CommandNode[] };
    const create = find(json.tree, 'teams create');
    expect(create).toBeDefined();
    // Every option is a {flags, description} pair, never a bare string.
    for (const opt of create!.options) {
      expect(typeof opt.flags).toBe('string');
      expect(opt.flags.length).toBeGreaterThan(0);
    }
  });

  it('renders scannable Markdown with a fenced block per group', async () => {
    const nodes = await tree();
    const md = renderMarkdown(nodes);
    expect(md).toContain('# Command index');
    expect(md).toContain('## teams');
    expect(md).toContain('agents teams create <team>');
    // Fenced code blocks are balanced (one open + close per group).
    expect((md.match(/^```$/gm) ?? []).length).toBe(nodes.length * 2);
  });
});
