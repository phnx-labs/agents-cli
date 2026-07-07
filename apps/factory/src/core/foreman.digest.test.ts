import { test, expect } from 'bun:test';
import { buildForemanDigest, humanElapsed, MAX_DETAILED_AGENTS } from './foreman.digest';

test('empty floor', () => {
  const d = buildForemanDigest([], []);
  expect(d.summary).toBe('floor is empty');
  expect(d.agents).toHaveLength(0);
  expect(d.concerns).toHaveLength(0);
});

test('single working claude', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      {
        name: 'Claude 12345678',
        label: 'auth refactor',
        sessionId: 'abc',
        startedAtMs: now - 12 * 60_000,
        lastActivityMs: now - 30_000,
        task: 'refactor the auth middleware to use jwt',
        recentFiles: ['/repo/src/auth/middleware.ts', '/repo/src/auth/jwt.ts'],
        recentTools: ['Read', 'Edit', 'Bash'],
        filesEdited: 3,
        toolCalls: 12,
      },
    ],
    [],
    [],
    now
  );
  expect(d.agents).toHaveLength(1);
  expect(d.agents[0].kind).toBe('claude');
  expect(d.agents[0].label).toBe('auth refactor');
  expect(d.agents[0].status).toBe('working');
  expect(d.agents[0].elapsed).toBe('12 min');
  expect(d.agents[0].task).toContain('refactor the auth');
  expect(d.agents[0].recent_files.length).toBe(2);
  expect(d.agents[0].files_edited).toBe(3);
  expect(d.summary).toContain('claude');
});

test('two claudes rolls up to plural count', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      { name: 'Claude - auth', lastActivityMs: now - 5_000 },
      { name: 'Claude - api', lastActivityMs: now - 5_000 },
      { name: 'Codex - ui', lastActivityMs: now - 5_000 },
    ],
    [],
    [],
    now
  );
  expect(d.summary).toContain('2 claude');
  expect(d.summary).toContain('codex');
});

test('long idle agent becomes concern with label', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      {
        name: 'Gemini - staging',
        label: 'staging',
        startedAtMs: now - 15 * 60_000,
        lastActivityMs: now - 5 * 60_000,
      },
    ],
    [],
    [],
    now
  );
  expect(d.agents[0].status).toBe('waiting');
  expect(d.concerns[0]).toContain('staging');
});

test('cloud dispatches surface in concerns + summary', () => {
  const d = buildForemanDigest(
    [],
    [{ id: 'abc', provider: 'rush', agent: 'claude', status: 'running', prompt: 'migrate the halo auth middleware', repo: 'x/y', updated: '' }]
  );
  expect(d.summary).toContain('cloud');
  expect(d.concerns.length).toBeGreaterThan(0);
  expect(d.concerns[0]).toContain('migrate the halo');
});

test('long paths get shortened', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      {
        name: 'Claude',
        lastActivityMs: now - 5_000,
        recentFiles: ['/Users/muqsit/deep/project/src/components/Thing.tsx'],
      },
    ],
    [],
    [],
    now
  );
  expect(d.agents[0].recent_files[0].startsWith('...')).toBe(true);
});

test('humanElapsed formatting', () => {
  expect(humanElapsed(5_000)).toBe('just now');
  expect(humanElapsed(59_000)).toBe('just now');
  expect(humanElapsed(90_000)).toBe('1 min');
  expect(humanElapsed(45 * 60_000)).toBe('45 min');
  expect(humanElapsed(60 * 60_000)).toBe('1h');
  expect(humanElapsed(75 * 60_000)).toBe('1h 15m');
});

test('non-agent terminals are ignored', () => {
  const d = buildForemanDigest([{ name: 'zsh' }, { name: 'bash' }], []);
  expect(d.agents).toHaveLength(0);
});

// The voice model recites every row it receives — a bare live pid with no
// task/label/tools became "Another Claude, no label - 3 min in IDE" spoken
// aloud. Agents with nothing to say must fold into the others rollup.
test('agents with no task, label, or tool activity fold into others', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      { name: 'Claude', kind: 'claude', sessionId: 'aaaa1111-x', openInIde: true, lastActivityMs: now - 5_000 },
      { name: 'Claude', kind: 'claude', sessionId: 'bbbb2222-x', openInIde: true, lastActivityMs: now - 5_000 },
      {
        name: 'Claude', kind: 'claude', sessionId: 'cccc3333-x',
        task: 'fix the auth bug', lastActivityMs: now - 5_000,
      },
    ],
    [], [], now
  );
  expect(d.agents).toHaveLength(1);
  expect(d.agents[0].task).toBe('fix the auth bug');
  expect(d.others?.count).toBe(2);
  expect(d.others?.kinds.claude).toBe(2);
  expect(d.others?.working).toBe(2);
  // Summary still counts everyone — the totals stay honest.
  expect(d.summary).toContain('3 agents local');
});

test('detailed rows cap at MAX_DETAILED_AGENTS with overflow in others', () => {
  const now = 1_700_000_000_000;
  const terminals = Array.from({ length: 10 }, (_, i) => ({
    name: 'Claude',
    kind: 'claude',
    sessionId: `sess${i}000-uuid-tail-${i}`,
    task: `task number ${i}`,
    // Two working (recent activity), the rest waiting — working must win the cap.
    lastActivityMs: i < 2 ? now - 5_000 : now - 5 * 60_000,
  }));
  const d = buildForemanDigest(terminals, [], [], now);
  expect(d.agents).toHaveLength(MAX_DETAILED_AGENTS);
  expect(d.agents[0].status).toBe('working');
  expect(d.agents[1].status).toBe('working');
  expect(d.others?.count).toBe(10 - MAX_DETAILED_AGENTS);
});

test('rows omit empty fields and truncate ids — nothing null reaches the voice model', () => {
  const now = 1_700_000_000_000;
  const d = buildForemanDigest(
    [
      {
        name: 'Claude', kind: 'claude',
        sessionId: '4a78949e-1234-5678-9abc-def012345678',
        label: 'auth work', lastActivityMs: now - 5_000,
      },
    ],
    [], [], now
  );
  expect(d.agents).toHaveLength(1);
  expect(d.agents[0].id).toBe('4a78949e');
  const payload = JSON.stringify(d.agents[0]);
  expect(payload).not.toContain('null');
  expect(payload).not.toContain('"task"');
  expect(payload).not.toContain('"last_tool"');
  expect(payload).not.toContain('"files_edited"');
  // No others rollup when every agent earned a detailed row.
  expect(d.others).toBeUndefined();
});
