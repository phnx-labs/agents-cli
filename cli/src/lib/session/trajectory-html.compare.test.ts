import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { diffTrajectories } from './trajectory-compare.js';
import { renderTrajectoryCompareHtml } from './trajectory-html.js';
import type { SessionEvent, SessionMeta } from './types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-0001',
    shortId: 'sess0001',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00Z',
    filePath: '/tmp/sess.jsonl',
    ...overrides,
  };
}

const eventsA: SessionEvent[] = [
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'a1', command: 'git fetch' },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'a1', outcome: 'ok' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:03Z', tool: 'Read', callId: 'a2', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:04Z', tool: 'Read', callId: 'a2', outcome: 'ok' },
];

const eventsB: SessionEvent[] = [
  { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'b1', command: 'git fetch' },
  { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:02Z', tool: 'Bash', callId: 'b1', outcome: 'ok' },
  { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:03Z', tool: 'Grep', callId: 'b2', args: { pattern: 'foo' } },
  { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:05Z', tool: 'Grep', callId: 'b2', outcome: 'error' },
];

describe('renderTrajectoryCompareHtml — self-contained and safe', () => {
  it('emits zero external URLs (no CDN, no web font, no remote asset)', () => {
    const a = buildTrajectory(eventsA, meta({ id: 'a', agent: 'claude' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }));
    const html = renderTrajectoryCompareHtml(diffTrajectories(a, b));
    const withoutSvgNs = html.replaceAll('http://www.w3.org/2000/svg', '');
    expect(withoutSvgNs).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/@import/);
    expect(html).not.toContain('cdn');
  });

  it('applies redaction to both sessions before compare renders', () => {
    const secret = 'sk-supersecrettoken1234567890';
    const withSecret: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: `deploy --token ${secret}` },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const a = buildTrajectory(withSecret, meta({ id: 'a' }), { redact: true, knownSecrets: [secret] });
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }), { redact: true, knownSecrets: [secret] });
    const html = renderTrajectoryCompareHtml(diffTrajectories(a, b));
    expect(html).not.toContain(secret);
  });

  it('renders the compare waterfall, divergence note, summary table, and diff lists', () => {
    const a = buildTrajectory(eventsA, meta({ id: 'a', agent: 'claude' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }));
    const html = renderTrajectoryCompareHtml(diffTrajectories(a, b));
    expect(html).toContain('<svg');
    expect(html).toContain('diverge after step');
    expect(html).toContain('class="cmp-table"');
    expect(html).toContain('Read');
    expect(html).toContain('Grep');
    expect(html).toContain('Only in claude');
    expect(html).toContain('Only in codex');
  });

  it('an identical pair still renders and states there is no divergence', () => {
    const a = buildTrajectory(eventsA, meta({ id: 'a' }));
    const b = buildTrajectory(eventsA, meta({ id: 'b' }));
    const html = renderTrajectoryCompareHtml(diffTrajectories(a, b));
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('No divergence');
  });

  it('footer honors the redaction flag of the compared trajectories (RUSH-3077)', () => {
    // Redacted build (the default) keeps the "Secret-redacted" claim.
    const ar = buildTrajectory(eventsA, meta({ id: 'a' }), { redact: true });
    const br = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }), { redact: true });
    expect(renderTrajectoryCompareHtml(diffTrajectories(ar, br))).toContain('Secret-redacted compare rendered');

    // --no-redact on both must read honestly, never claim redaction that did not happen.
    const au = buildTrajectory(eventsA, meta({ id: 'a' }), { redact: false });
    const bu = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }), { redact: false });
    const unredacted = renderTrajectoryCompareHtml(diffTrajectories(au, bu));
    expect(unredacted).toContain('Unredacted (local only) compare rendered');
    expect(unredacted).not.toContain('Secret-redacted');

    // A mixed pair (one side still redacted) is not "unredacted" — the honest
    // label is the redacted one, so no false safe-to-share claim.
    expect(renderTrajectoryCompareHtml(diffTrajectories(ar, bu))).toContain('Secret-redacted compare rendered');
  });
});
