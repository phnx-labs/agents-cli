import { describe, it, expect, vi } from 'vitest';
import { createLeaseOutputRouter, createSpinner, LEASE_AGENT_MARKER } from './progress.js';

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, write: (s: string) => { writes.push(s); return true; }, writes };
}

describe('createSpinner', () => {
  it('writes exactly one line per tick and nowhere else — cannot storm on update()', () => {
    vi.useFakeTimers();
    try {
      const s = fakeStream(true);
      const spin = createSpinner({ stream: s, intervalMs: 100 });
      spin.start('warming');
      const afterStart = s.writes.length; // one initial frame
      // A flood of updates between ticks must NOT write anything on its own.
      for (let i = 0; i < 100_000; i++) spin.update(`line ${i}`);
      expect(s.writes.length).toBe(afterStart);
      // Only the timer produces writes — one per interval.
      vi.advanceTimersByTime(350);
      expect(s.writes.length - afterStart).toBe(3);
      spin.stopAndPersist('✔', 'done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a non-TTY prints each phase label once and stays silent on update (no flood)', () => {
    const s = fakeStream(false);
    const spin = createSpinner({ stream: s });
    spin.start('warming');
    for (let i = 0; i < 1000; i++) spin.update(`x ${i}`);
    spin.stopAndPersist('✔', 'ready');
    expect(s.writes.join('')).toBe('warming\n✔ ready\n');
  });

  it('stop() clears the timer so no writes happen afterward', () => {
    vi.useFakeTimers();
    try {
      const s = fakeStream(true);
      const spin = createSpinner({ stream: s, intervalMs: 50 });
      spin.start('x');
      spin.stop();
      const n = s.writes.length;
      vi.advanceTimersByTime(500);
      expect(s.writes.length).toBe(n);
      expect(spin.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function run(chunks: string[]) {
  const setup: string[] = [];
  let agent = '';
  const r = createLeaseOutputRouter({
    onSetupLine: (l) => setup.push(l),
    onAgentChunk: (c) => (agent += c),
  });
  for (const c of chunks) r.push(c);
  r.end();
  return { setup, agent, sawAgent: r.sawAgent(), captured: r.setupLines() };
}

describe('createLeaseOutputRouter', () => {
  it('routes lines before the marker to setup, and text after it to the agent', () => {
    const { setup, agent, sawAgent } = run([
      'syncing...\n',
      'still syncing after 15s...\n',
      `${LEASE_AGENT_MARKER}\n`,
      'LOGIN_OK\n',
    ]);
    expect(setup).toEqual(['syncing...', 'still syncing after 15s...']);
    expect(agent).toBe('LOGIN_OK\n');
    expect(sawAgent).toBe(true);
  });

  it('never prints the marker line itself', () => {
    const { setup, agent } = run([`before\n${LEASE_AGENT_MARKER}\nafter\n`]);
    expect(setup).toEqual(['before']);
    expect(agent).toBe('after\n');
    expect(agent).not.toContain(LEASE_AGENT_MARKER);
    expect(setup.join('\n')).not.toContain(LEASE_AGENT_MARKER);
  });

  it('handles the marker split across chunk boundaries', () => {
    const half = LEASE_AGENT_MARKER.slice(0, 10);
    const rest = LEASE_AGENT_MARKER.slice(10);
    const { setup, agent } = run(['setup line\n', half, `${rest}\n`, 'agent out']);
    expect(setup).toEqual(['setup line']);
    expect(agent).toBe('agent out');
  });

  it('flushes agent text that arrives on the same line-buffer as the marker', () => {
    const { agent } = run([`${LEASE_AGENT_MARKER}\ninstant reply\n`]);
    expect(agent).toBe('instant reply\n');
  });

  it('streams every post-marker chunk raw (not line-buffered)', () => {
    const { agent } = run([`${LEASE_AGENT_MARKER}\n`, 'partial', ' more', '\ndone']);
    expect(agent).toBe('partial more\ndone');
  });

  it('captures setup lines and reports no agent when the marker never arrives (setup failure)', () => {
    const { setup, agent, sawAgent, captured } = run([
      'installing node...\n',
      'lease bootstrap: agents-cli install failed\n',
    ]);
    expect(sawAgent).toBe(false);
    expect(agent).toBe('');
    expect(captured).toEqual(setup);
    expect(captured).toContain('lease bootstrap: agents-cli install failed');
  });

  it('drops blank/whitespace-only setup lines but keeps real ones', () => {
    const { setup } = run(['\n', '  \n', 'real\n', '\r\n']);
    expect(setup).toEqual(['real']);
  });
});
