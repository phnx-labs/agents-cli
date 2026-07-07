import { describe, it, expect } from 'vitest';
import {
  classifyTerminal,
  composePromptWithPlaybook,
  renderWatchdogPrompt,
  parseWatchdogResponse,
  isLikelyTrulyBlocked,
  WATCHDOG_SYSTEM_PROMPT,
} from './watchdog.js';

describe('classifyTerminal', () => {
  const base = {
    nowMs: 1_000_000,
    lastNudgeMs: null,
    optedOut: false,
    stallMs: 90_000,
    cooldownMs: 300_000,
    dormantMs: 3_600_000,
  };

  it('active when within stall window', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 10_000 });
    expect(r.kind).toBe('active');
  });

  it('opted_out when user disabled watchdog for terminal', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 120_000,
      optedOut: true,
    });
    expect(r.kind).toBe('opted_out');
  });

  it('dormant when session is older than dormant window', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 3_600_001 });
    expect(r.kind).toBe('dormant');
  });

  it('rate_limited when recently nudged', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 120_000,
      lastNudgeMs: base.nowMs - 60_000,
    });
    expect(r.kind).toBe('rate_limited');
    if (r.kind === 'rate_limited') {
      expect(r.cooldownRemainingMs).toBe(240_000);
    }
  });

  it('stalled when past threshold, not dormant, not rate limited, not opted out', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 120_000 });
    expect(r.kind).toBe('stalled');
    if (r.kind === 'stalled') {
      expect(r.stalledForMs).toBe(120_000);
    }
  });

  it('opt-out wins over active', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 10_000,
      optedOut: true,
    });
    expect(r.kind).toBe('opted_out');
  });

  it('cooldown expired lets terminal go back to stalled', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 400_000,
      lastNudgeMs: base.nowMs - 310_000,
    });
    expect(r.kind).toBe('stalled');
  });

  it('active takes priority even when a nudge is on cooldown (boundary just under stall)', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 89_999,
      lastNudgeMs: base.nowMs - 1_000,
    });
    expect(r.kind).toBe('active');
  });

  it('exactly at the stall threshold is not yet active (age === stallMs)', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 90_000 });
    expect(r.kind).toBe('stalled');
  });
});

describe('composePromptWithPlaybook', () => {
  it('returns the base prompt unchanged when playbook is empty', () => {
    expect(composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, '')).toBe(WATCHDOG_SYSTEM_PROMPT);
  });

  it('returns the base prompt unchanged when playbook is only whitespace', () => {
    expect(composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, '   \n\n   ')).toBe(WATCHDOG_SYSTEM_PROMPT);
  });

  it('appends a House Rules section with the trimmed playbook content', () => {
    const playbook = '\n\n- Nudge with TEST_MARKER when lint hangs.\n- Skip in plan mode.\n\n';
    const out = composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, playbook);
    expect(out.startsWith(WATCHDOG_SYSTEM_PROMPT + '\n\n## House Rules')).toBe(true);
    expect(out).toContain('TEST_MARKER');
    expect(out).toContain('Skip in plan mode');
    // trailing whitespace stripped
    expect(out.endsWith('\n')).toBe(false);
  });
});

describe('renderWatchdogPrompt', () => {
  it('matches base prompt when no playbook is passed (zero regression)', () => {
    const out = renderWatchdogPrompt([
      { terminalId: 'CC-1', agentType: 'claude', tailLines: ['{}'], stalledForMs: 60_000 },
    ]);
    expect(out).toContain(WATCHDOG_SYSTEM_PROMPT);
    expect(out).not.toContain('## House Rules');
  });

  it('appends House Rules block when a non-empty playbook is passed', () => {
    const out = renderWatchdogPrompt(
      [{ terminalId: 'CC-1', agentType: 'claude', tailLines: ['{}'], stalledForMs: 60_000 }],
      '- Nudge with TEST_MARKER when stuck on lint.'
    );
    expect(out).toContain('## House Rules');
    expect(out).toContain('TEST_MARKER');
    // House Rules must be ABOVE the stalled-terminals payload, not after it.
    const houseIdx = out.indexOf('## House Rules');
    const stalledIdx = out.indexOf('STALLED TERMINALS:');
    expect(houseIdx).toBeGreaterThan(-1);
    expect(stalledIdx).toBeGreaterThan(houseIdx);
  });

  it('embeds terminal id, agent type, stall duration, and JSONL tail', () => {
    const out = renderWatchdogPrompt([
      {
        terminalId: 'CC-1',
        agentType: 'claude',
        tailLines: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"I\'ll write inventory.sh."}]}}',
        ],
        stalledForMs: 120_000,
      },
    ]);
    expect(out).toContain('CC-1');
    expect(out).toContain('claude');
    expect(out).toContain('idle 120s');
    expect(out).toContain("I'll write inventory.sh");
    expect(out).toContain('JSON array');
  });

  it('separates multiple terminals into labeled sections', () => {
    const out = renderWatchdogPrompt([
      { terminalId: 'CC-1', agentType: 'claude', tailLines: ['{"a":1}'], stalledForMs: 100_000 },
      { terminalId: 'CX-2', agentType: 'codex', tailLines: ['{"b":2}'], stalledForMs: 200_000 },
    ]);
    expect(out).toContain('terminal CC-1');
    expect(out).toContain('terminal CX-2');
    expect(out).toContain('idle 100s');
    expect(out).toContain('idle 200s');
  });
});

describe('parseWatchdogResponse', () => {
  it('parses a clean JSON array', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"nudge","text":"Show the file.","reason":"broken_promise"}]'
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({
      terminalId: 'CC-1',
      action: 'nudge',
      text: 'Show the file.',
      reason: 'broken_promise',
    });
  });

  it('tolerates leading and trailing prose', () => {
    const d = parseWatchdogResponse(
      'Here is the response:\n[{"terminalId":"CC-1","action":"skip","text":"","reason":"waiting_on_user"}]\nThanks.'
    );
    expect(d).toHaveLength(1);
    expect(d[0].action).toBe('skip');
  });

  it('returns empty on malformed JSON', () => {
    expect(parseWatchdogResponse('not json at all')).toEqual([]);
    expect(parseWatchdogResponse('[{invalid]')).toEqual([]);
  });

  it('skips entries missing required fields', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"nudge","text":"ok","reason":"r"},{"action":"nudge"},{"terminalId":"CX-2"}]'
    );
    expect(d).toHaveLength(1);
    expect(d[0].terminalId).toBe('CC-1');
  });

  it('rejects unknown action values', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"explode","text":"","reason":""}]'
    );
    expect(d).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseWatchdogResponse('')).toEqual([]);
    expect(parseWatchdogResponse('   \n ')).toEqual([]);
  });

  it('extracts the array even when wrapped in a markdown code fence', () => {
    const d = parseWatchdogResponse(
      '```json\n[{"terminalId":"CC-1","action":"nudge","text":"Run tests.","reason":"stalled"}]\n```'
    );
    expect(d).toHaveLength(1);
    expect(d[0].text).toBe('Run tests.');
  });
});

describe('isLikelyTrulyBlocked', () => {
  it('returns true for explicit blocked/error hints', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: ['{"type":"assistant","message":{"content":[{"type":"text","text":"The command failed with permission denied."}]}}'],
      })
    ).toBe(true);
  });

  it('returns true when assistant promised action but no tool call followed', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: ['{"type":"assistant","message":{"content":[{"type":"text","text":"I will run bun test now."}]}}'],
      })
    ).toBe(true);
  });

  it('returns false when a tool call happened after the promise', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"I will run bun test now."}]}}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
        ],
      })
    ).toBe(false);
  });

  it('returns false for waiting-on-user hints', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: ['{"type":"assistant","message":{"content":[{"type":"text","text":"Waiting on user response."}]}}'],
      })
    ).toBe(false);
  });

  it('returns true for very long stalls even without textual hints', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 901_000,
        tailLines: ['{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}'],
      })
    ).toBe(true);
  });

  it('returns false on an empty tail below the force-review threshold', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: [],
      })
    ).toBe(false);
  });

  it('completion hints suppress a nudge even when a promise is present', () => {
    expect(
      isLikelyTrulyBlocked({
        terminalId: 'CC-1',
        agentType: 'claude',
        stalledForMs: 120_000,
        tailLines: ['{"type":"assistant","message":{"content":[{"type":"text","text":"I will stop here, all set and finished."}]}}'],
      })
    ).toBe(false);
  });
});
