#!/usr/bin/env bun
/**
 * Test harness for the staleness library. End-to-end test files spawn this
 * with a custom `$HOME` env var, so the library resolves real user/system
 * paths into a temp tree instead of the developer's home directory. This
 * sidesteps the need for any module mocking — every call is real I/O
 * against a real filesystem.
 *
 * Protocol:
 *   bun _harness.ts '<json-op>'
 *   stdout: '<json-result>'
 *
 * Operations:
 *   { cmd: 'build',   agent, version, cwd }
 *     → builds + saves manifest. Result: { manifest }
 *   { cmd: 'isStale', agent, version, cwd }
 *     → loads manifest, returns staleness. Result: { stale, exists }
 *   { cmd: 'list',    type,   cwd }
 *     → returns names from one checker. Result: { names }
 */

import type { AgentId } from '../../types.js';
import {
  buildManifest,
  saveManifest,
  loadManifest,
  isStale,
} from '../index.js';

import { commandsChecker }   from '../checkers/commands.js';
import { skillsChecker }     from '../checkers/skills.js';
import { hooksChecker }      from '../checkers/hooks.js';
import { mcpChecker }        from '../checkers/mcp.js';
import { subagentsChecker }  from '../checkers/subagents.js';
import { workflowsChecker }  from '../checkers/workflows.js';
import { pluginsChecker }    from '../checkers/plugins.js';
import type { ResourceChecker } from '../checkers/types.js';

type Op =
  | { cmd: 'build';   agent: AgentId; version: string; cwd: string }
  | { cmd: 'isStale'; agent: AgentId; version: string; cwd: string }
  | { cmd: 'list';    type: string;   cwd: string };

const CHECKERS: Record<string, ResourceChecker> = {
  commands:  commandsChecker,
  skills:    skillsChecker,
  hooks:     hooksChecker,
  mcp:       mcpChecker,
  subagents: subagentsChecker,
  workflows: workflowsChecker,
  plugins:   pluginsChecker,
};

function run(op: Op): unknown {
  if (op.cmd === 'build') {
    const m = buildManifest(op.agent, op.version, op.cwd);
    saveManifest(op.agent, op.version, m);
    return { manifest: m };
  }
  if (op.cmd === 'isStale') {
    const m = loadManifest(op.agent, op.version);
    if (!m) return { stale: true, exists: false };
    return { stale: isStale(m, op.agent, op.version, op.cwd), exists: true };
  }
  if (op.cmd === 'list') {
    const c = CHECKERS[op.type];
    if (!c) throw new Error(`unknown checker: ${op.type}`);
    return { names: c.listNames(op.cwd) };
  }
  throw new Error(`unknown cmd: ${(op as { cmd: string }).cmd}`);
}

const raw = process.argv[2];
if (!raw) {
  console.error('usage: _harness.ts <json-op>');
  process.exit(2);
}

try {
  const result = run(JSON.parse(raw) as Op);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  process.stderr.write(String((err as Error)?.message ?? err));
  process.exit(1);
}
