import { describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'user|||text|||{"text":"hello"}|||0\n'),
}));

const { parseOpenCode } = await import('../parse.js');

describe('parseOpenCode subprocess execution', () => {
  test('passes sqlite path and query as argv instead of a shell command', () => {
    const dbPath = '/tmp/opencode "; touch /tmp/pwned.db';
    const events = parseOpenCode(`${dbPath}#session-1`);

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('hello');
    expect(execFileSync).toHaveBeenCalledWith(
      'sqlite3',
      expect.arrayContaining(['-separator', '|||', dbPath]),
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });
});
