import { describe, test, expect } from 'bun:test';
import {
  createEntry,
  markEvent,
  resetFrom,
  waitFor,
  dispose,
  hasFired,
  READINESS_ORDER,
} from './terminalReadiness';

describe('terminalReadiness', () => {
  test('new entry has no events fired', () => {
    const e = createEntry();
    for (const ev of READINESS_ORDER) {
      expect(hasFired(e, ev)).toBe(false);
    }
  });

  test('marking promptReady cascades to tabReady and shellReady', () => {
    const e = createEntry();
    markEvent(e, 'promptReady', 1000);
    expect(e.state.tabReadyAt).toBe(1000);
    expect(e.state.shellReadyAt).toBe(1000);
    expect(e.state.promptReadyAt).toBe(1000);
    expect(e.state.agentReadyAt).toBe(null);
  });

  test('marking agentReady cascades to all lower events', () => {
    const e = createEntry();
    markEvent(e, 'agentReady', 2000);
    expect(e.state.tabReadyAt).toBe(2000);
    expect(e.state.shellReadyAt).toBe(2000);
    expect(e.state.promptReadyAt).toBe(2000);
    expect(e.state.agentReadyAt).toBe(2000);
  });

  test('earlier timestamps are preserved when later events mark later', () => {
    const e = createEntry();
    markEvent(e, 'tabReady', 100);
    markEvent(e, 'shellReady', 200);
    markEvent(e, 'promptReady', 300);
    expect(e.state.tabReadyAt).toBe(100);
    expect(e.state.shellReadyAt).toBe(200);
    expect(e.state.promptReadyAt).toBe(300);
  });

  test('re-marking is idempotent — does not overwrite timestamp', () => {
    const e = createEntry();
    markEvent(e, 'promptReady', 1000);
    markEvent(e, 'promptReady', 5000);
    expect(e.state.promptReadyAt).toBe(1000);
  });

  test('waitFor resolves immediately if already fired', async () => {
    const e = createEntry();
    markEvent(e, 'promptReady');
    await expect(waitFor(e, 'promptReady')).resolves.toBeUndefined();
    await expect(waitFor(e, 'shellReady')).resolves.toBeUndefined();
  });

  test('waitFor resolves when event fires later', async () => {
    const e = createEntry();
    const p = waitFor(e, 'promptReady');
    setTimeout(() => markEvent(e, 'promptReady'), 10);
    await expect(p).resolves.toBeUndefined();
  });

  test('multiple concurrent waiters all resolve on single fire', async () => {
    const e = createEntry();
    const w1 = waitFor(e, 'agentReady');
    const w2 = waitFor(e, 'agentReady');
    const w3 = waitFor(e, 'agentReady');
    markEvent(e, 'agentReady');
    await Promise.all([w1, w2, w3]);
  });

  test('waitFor rejects on timeout', async () => {
    const e = createEntry();
    await expect(waitFor(e, 'promptReady', { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  test('waitFor does not reject on timeout if event fires first', async () => {
    const e = createEntry();
    setTimeout(() => markEvent(e, 'promptReady'), 5);
    await expect(waitFor(e, 'promptReady', { timeoutMs: 100 })).resolves.toBeUndefined();
  });

  test('resetFrom clears the given event and all higher events', () => {
    const e = createEntry();
    markEvent(e, 'agentReady', 100);
    resetFrom(e, 'promptReady');
    expect(e.state.tabReadyAt).toBe(100);
    expect(e.state.shellReadyAt).toBe(100);
    expect(e.state.promptReadyAt).toBe(null);
    expect(e.state.agentReadyAt).toBe(null);
  });

  test('resetFrom lets subsequent waitFor re-arm', async () => {
    const e = createEntry();
    markEvent(e, 'agentReady');
    resetFrom(e, 'agentReady');
    const p = waitFor(e, 'agentReady');
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    markEvent(e, 'agentReady');
    await p;
    expect(resolved).toBe(true);
  });

  test('dispose rejects all pending waiters', async () => {
    const e = createEntry();
    const p1 = waitFor(e, 'promptReady');
    const p2 = waitFor(e, 'agentReady');
    dispose(e, 'terminal closed');
    await expect(p1).rejects.toThrow(/terminal closed/);
    await expect(p2).rejects.toThrow(/terminal closed/);
  });

  test('waitFor on disposed entry rejects immediately', async () => {
    const e = createEntry();
    dispose(e);
    await expect(waitFor(e, 'tabReady')).rejects.toThrow();
  });

  test('markEvent is a no-op on disposed entry', () => {
    const e = createEntry();
    dispose(e);
    markEvent(e, 'promptReady');
    expect(e.state.promptReadyAt).toBe(null);
  });
});
