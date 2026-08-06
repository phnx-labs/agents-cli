/**
 * Pins the hooks capability table to `registerHooksToSettings`'s actual
 * per-agent branches so the two can never drift again the way they did for
 * OpenClaw (RUSH-2122): `capabilities.hooks: true` with no `agentId ===
 * 'openclaw'` case in the registrar, so `agents sync openclaw` silently
 * installed zero hooks while `agents doctor` reported the agent as capable.
 *
 * This is a static source check, not a runtime one: each registrar writes to
 * a different config shape (Claude-family settings.json, Codex's
 * config.toml, OpenCode's generated plugin), so exercising every one through
 * a real version home belongs to their own dedicated tests. What this test
 * guarantees is narrower and load-bearing on its own — every agent whose
 * capability table claims `hooks: true` has SOME branch in
 * `registerHooksToSettings`, so a capability flip can never again ship with
 * no registrar behind it.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { capableAgents } from './capabilities.js';

describe('hooks capability <-> registrar completeness', () => {
  it('every hooks-capable agent has a branch in registerHooksToSettings', () => {
    const hooksSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/hooks.ts'), 'utf-8');
    const start = hooksSource.indexOf('export function registerHooksToSettings');
    expect(start).toBeGreaterThan(-1);
    // The function's final `return { registered: [], errors: [] };` (the
    // openclaw-shaped fallthrough) precedes the next top-level declaration —
    // slice up to there so the search doesn't spill into per-agent registrar
    // bodies that also mention `agentId` in comments.
    const nextDecl = hooksSource.indexOf('\nconst OPENCODE_DIRECT_EVENT_MAP', start);
    expect(nextDecl).toBeGreaterThan(start);
    const registrarBody = hooksSource.slice(start, nextDecl);

    const missing = capableAgents('hooks').filter(
      (id) => !registrarBody.includes(`agentId === '${id}'`)
    );

    expect(missing).toEqual([]);
  });
});
