import { describe, it, expect, afterEach, vi } from 'vitest';

import { runFork, type ForkDeps } from './fork.js';

/** Capture a console channel's output as one joined string. */
function capture(channel: 'log' | 'error') {
  const lines: string[] = [];
  const spy = vi.spyOn(console, channel).mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  return { get text() { return lines.join('\n'); }, restore: () => spy.mockRestore() };
}

/** A preview --json payload as `renderSessionPreview` emits it. */
function previewJson(session: object, preview: object | null): string {
  return JSON.stringify({ schemaVersion: 1, session, active: null, preview, error: null });
}

/** Deps whose preview returns a canned payload and whose launch records the argv. */
function fakeDeps(preview: { status?: number; stdout?: string }): { deps: ForkDeps; launched: string[][] } {
  const launched: string[][] = [];
  return {
    launched,
    deps: {
      runPreview: () => ({ status: preview.status ?? 0, stdout: preview.stdout ?? '' }),
      launch: (sub) => { launched.push(sub); return { status: 0 }; },
    },
  };
}

afterEach(() => { process.exitCode = 0; });

describe('agents sessions fork (recap-seeded sibling)', () => {
  it('resolves the source and launches a same-harness sibling seeded with a recap', async () => {
    const src = {
      id: '11111111-2222-3333-4444-555555555555', shortId: '11111111', agent: 'claude',
      cwd: '/home/u/prix', ticketId: 'PHNX-3397', machine: 'yosemite-m1', label: 'Prix Evals',
    };
    const { deps, launched } = fakeDeps({
      stdout: previewJson(src, { lastAssistant: 'insight widgets need gaps closed', changes: { created: 2, modified: 1, deleted: 0 } }),
    });

    const err = capture('error');
    await runFork(src.id, {}, deps);
    err.restore();

    expect(launched).toHaveLength(1);
    const [args] = launched;
    // Same harness, interactive, load-balanced, seeded with the recap prompt.
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('claude');
    expect(args).toContain('-i');
    expect(args.slice(args.indexOf('--strategy'))).toEqual(expect.arrayContaining(['--strategy', 'balanced']));
    const recap = args[2];
    expect(recap).toContain('Continue a prior claude session ("Prix Evals")');
    expect(recap).toContain('insight widgets need gaps closed');
    expect(recap).toContain('/continue 11111111-2222-3333-4444-555555555555');
    // A default fork label rides through.
    expect(args.slice(args.indexOf('--name'))).toEqual(expect.arrayContaining(['--name', 'fork of Prix Evals']));
  });

  it('forks a CROSS-DEVICE, non-claude source where the old transcript copy threw "transcript not found"', async () => {
    // A codex session owned by another box: old fork refused it twice over
    // (non-claude gate + local-only transcript lookup). Now it launches.
    const src = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', shortId: 'aaaaaaaa', agent: 'codex', cwd: '/w', machine: 'mark-1', label: 'remote codex' };
    const { deps, launched } = fakeDeps({ stdout: previewJson(src, { lastAssistant: 'done step 1', changes: { created: 0, modified: 0, deleted: 0 } }) });

    await runFork('aaaaaaaa', {}, deps);

    expect(process.exitCode ?? 0).toBe(0);
    expect(launched[0][1]).toBe('codex');
    expect(launched[0][2]).toContain('Source session aaaaaaaa on mark-1');
  });

  it('honors --name and --device on the launched sibling', async () => {
    const src = { id: 'cccccccc-1111-2222-3333-444444444444', shortId: 'cccccccc', agent: 'claude', label: 'x' };
    const { deps, launched } = fakeDeps({ stdout: previewJson(src, null) });

    await runFork('cccccccc', { name: 'try redis instead', device: 'auto' }, deps);

    const [args] = launched;
    expect(args.slice(args.indexOf('--name'))).toEqual(expect.arrayContaining(['--name', 'try redis instead']));
    expect(args.slice(args.indexOf('--device'))).toEqual(expect.arrayContaining(['--device', 'auto']));
  });

  it('falls back to the source topic (not the raw short id) when it has no explicit label', async () => {
    // The common case: an unnamed session. preview --json carries `topic` but no
    // `label`; the recap must show the human-meaningful topic.
    const src = { id: 'dddddddd-1111-2222-3333-444444444444', shortId: 'dddddddd', agent: 'claude', topic: 'wire up the evals console' };
    const { deps, launched } = fakeDeps({ stdout: previewJson(src, null) });

    await runFork('dddddddd', {}, deps);

    const [args] = launched;
    expect(args[2]).toContain('wire up the evals console');
    expect(args[2]).not.toContain('("dddddddd")');
    expect(args.slice(args.indexOf('--name'))).toEqual(expect.arrayContaining(['--name', 'fork of wire up the evals console']));
  });

  it('rejects --device + --terminal up front, before launching anything', async () => {
    const src = { id: 'ffffffff-1111-2222-3333-444444444444', shortId: 'ffffffff', agent: 'claude', label: 'x' };
    const { deps, launched } = fakeDeps({ stdout: previewJson(src, null) });

    const err = capture('error');
    await runFork('ffffffff', { device: 'auto', terminal: true }, deps);
    err.restore();

    expect(process.exitCode).toBe(1);
    expect(err.text).toContain('cannot combine');
    expect(launched).toHaveLength(0);
  });

  it('forwards --terminal so the sibling opens in a fresh tab', async () => {
    const src = { id: 'eeeeeeee-1111-2222-3333-444444444444', shortId: 'eeeeeeee', agent: 'claude', label: 'x' };
    const { deps, launched } = fakeDeps({ stdout: previewJson(src, null) });

    await runFork('eeeeeeee', { terminal: true }, deps);
    expect(launched[0]).toContain('--terminal');

    launched.length = 0;
    await runFork('eeeeeeee', { terminal: 'ghostty' }, deps);
    const [args] = launched;
    expect(args.slice(args.indexOf('--terminal'))).toEqual(expect.arrayContaining(['--terminal', 'ghostty']));
  });

  it('propagates a preview resolution failure and never launches a context-less sibling', async () => {
    // preview prints "No session matching…" to stderr (inherited) and exits 1.
    const { deps, launched } = fakeDeps({ status: 1, stdout: '' });

    await runFork('does-not-exist-zzzz', {}, deps);

    expect(process.exitCode).toBe(1);
    expect(launched).toHaveLength(0);
  });
});
