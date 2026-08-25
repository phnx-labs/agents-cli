import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { renderTrajectoryText } from './trajectory-text.js';
import type { SessionEvent, SessionMeta } from './types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-0001',
    shortId: 'sess0001',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00Z',
    filePath: '/tmp/sess.jsonl',
    model: 'opus-4.8',
    ...overrides,
  };
}

const events: SessionEvent[] = [
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Read', callId: 'r1', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Read', callId: 'r1', outcome: 'ok' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'b1', command: 'bun test exec.test.ts' },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:05Z', tool: 'Bash', callId: 'b1', outcome: 'error', exitCode: 1, output: 'exit 1 · 2 failing' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:08:05Z', tool: 'Edit', callId: 'e1', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:06Z', tool: 'Edit', callId: 'e1', outcome: 'ok' },
];

describe('renderTrajectoryText', () => {
  it('is ANSI-free and starts with a one-line header', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()));
    expect(text.includes(String.fromCharCode(27))).toBe(false); // no ANSI escape sequences
    expect(text.split('\n')[0]).toContain('sess0001 claude·opus-4.8');
    expect(text).toContain('3 tools');
    expect(text).toContain('1✗');
  });

  it('lists steps with tool, label, duration, and marks the error', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()));
    // Bash steps read by their effective program, with the exit code surfaced.
    expect(text).toMatch(/bun\s+bun test exec\.test\.ts\s+8m04s exit 1 ✗/);
    expect(text).toContain('exit 1 · 2 failing'); // error evidence line
  });

  it('renders a multi-hour idle stall in hours, not runaway minutes', () => {
    // A completed step, then nothing for 2h05m — an overnight stall. Minutes-only
    // used to print "125m…"; it should read as hours.
    const overnight: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'b', command: 'git status' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'b', outcome: 'ok' },
      { type: 'message', agent: 'claude', timestamp: '2026-08-01T02:05:01Z', role: 'user', content: 'back' },
    ];
    const idleLine = renderTrajectoryText(buildTrajectory(overnight, meta()))
      .split('\n').find((l) => l.startsWith('idle'))!;
    expect(idleLine).toBe('idle 2h05m after step 1 (stall)');
    expect(idleLine).not.toMatch(/125m/); // not runaway minutes
  });

  it('errorsOnly collapses to the error step and its neighbours', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()), { errorsOnly: true });
    // Step 2 is the error (a `bun test`, tagged by its program); steps 1 and 3 are neighbours.
    expect(text).toContain('bun'); // the error step, read by its effective program
    expect(text).toContain('Edit'); // neighbour after
    // With only 3 of 3 tool steps kept here, assert the collapse mechanism on a longer run below.
  });

  it('errorsOnly drops far-from-error steps and inserts a collapse marker', () => {
    const many: SessionEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const ts = `2026-08-01T00:00:0${i}Z`;
      many.push({ type: 'tool_use', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, args: { file_path: `f${i}.ts` } });
      many.push({ type: 'tool_result', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, outcome: i === 5 ? 'error' : 'ok' });
    }
    const text = renderTrajectoryText(buildTrajectory(many, meta()), { errorsOnly: true });
    expect(text).toContain('…'); // collapse marker for the omitted head
    expect(text).not.toContain('f0.ts'); // far-from-error step dropped
    expect(text).toContain('f5.ts'); // the error step kept
    expect(text).toContain('f6.ts'); // neighbour kept
  });

  it('is bounded: a huge session collapses the step list with a count', () => {
    const many: SessionEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const ts = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString();
      many.push({ type: 'tool_use', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, args: { file_path: `f${i}.ts` } });
      many.push({ type: 'tool_result', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, outcome: 'ok' });
    }
    const text = renderTrajectoryText(buildTrajectory(many, meta()), { maxSteps: 50 });
    expect(text.split('\n').length).toBeLessThan(70); // bounded, not 300 lines
    expect(text).toMatch(/… \d+ more steps/);
  });

  it('"where the time went" is keyed BY PROGRAM, never a single opaque "Bash"', () => {
    // A Bash-heavy run of three distinct programs — git 56%, gh 33%, agents 11%.
    const shell: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'g1', command: 'git fetch origin && git worktree add wt' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:50Z', tool: 'Bash', callId: 'g1', outcome: 'ok' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:50Z', tool: 'Bash', callId: 'h1', command: 'gh pr checks 2971 --watch' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:01:20Z', tool: 'Bash', callId: 'h1', outcome: 'ok' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:01:20Z', tool: 'Bash', callId: 'a1', command: 'agents sessions --active' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:01:30Z', tool: 'Bash', callId: 'a1', outcome: 'ok' },
    ];
    const text = renderTrajectoryText(buildTrajectory(shell, meta()));
    const line = text.split('\n').find((l) => l.startsWith('where the time went:'))!;
    expect(line).toContain('git 56%');
    expect(line).toContain('gh 33%');
    expect(line).toContain('agents 11%');
    expect(line).not.toContain('Bash'); // the bug: the whole run collapsing to one tool
  });

  it('redacts a secret in a step label', () => {
    const secret = 'sk-supersecrettoken1234567890';
    const withSecret: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: `auth ${secret}` },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const text = renderTrajectoryText(buildTrajectory(withSecret, meta(), { redact: true, knownSecrets: [secret] }));
    expect(text).not.toContain(secret);
  });
});
