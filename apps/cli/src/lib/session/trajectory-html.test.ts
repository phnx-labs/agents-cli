import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { renderTrajectoryHtml } from './trajectory-html.js';
import type { SessionEvent, SessionMeta } from './types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-0001',
    shortId: 'sess0001',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00Z',
    filePath: '/tmp/sess.jsonl',
    model: 'opus-4.8',
    project: 'AGI',
    ...overrides,
  };
}

const events: SessionEvent[] = [
  { type: 'message', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', role: 'user', content: 'go' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:02Z', tool: 'Read', callId: 'r1', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:03Z', tool: 'Read', callId: 'r1', outcome: 'ok' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:03Z', tool: 'Bash', callId: 'b1', command: 'bun test' },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:07Z', tool: 'Bash', callId: 'b1', outcome: 'error', exitCode: 1, output: '2 failing' },
  { type: 'usage', agent: 'claude', timestamp: '2026-08-01T00:08:08Z', outputTokens: 18_400 },
];

describe('renderTrajectoryHtml — self-contained and safe', () => {
  it('emits zero external URLs (no CDN, no web font, no remote asset)', () => {
    const html = renderTrajectoryHtml(buildTrajectory(events, meta()));
    // The only permitted http(s) token is the inline-SVG XML namespace, which is
    // a declaration — never a network fetch. Nothing else may load remotely.
    const withoutSvgNs = html.replaceAll('http://www.w3.org/2000/svg', '');
    expect(withoutSvgNs).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/src\s*=\s*["']http/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/@import/);
    expect(html).not.toContain('cdn');
  });

  it('applies redaction: a secret in a command never reaches the HTML', () => {
    const secret = 'sk-supersecrettoken1234567890';
    const withSecret: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: `deploy --token ${secret}` },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const html = renderTrajectoryHtml(buildTrajectory(withSecret, meta(), { redact: true, knownSecrets: [secret] }));
    expect(html).not.toContain(secret);
    expect(html).toContain('Secret-redacted trajectory');
  });

  it('footer tells the truth under --no-redact (not a false "Secret-redacted" claim)', () => {
    const html = renderTrajectoryHtml(buildTrajectory(events, meta(), { redact: false }));
    expect(html).toContain('Unredacted (local only) trajectory');
    expect(html).not.toContain('Secret-redacted trajectory');
  });

  it('renders the waterfall, time-share, and per-step detail sections', () => {
    const html = renderTrajectoryHtml(buildTrajectory(events, meta()));
    expect(html).toContain('<svg');
    expect(html).toContain('Where the time went');
    expect(html).toContain('id="step-1"');
    expect(html).toContain('exec.ts');
    // An error outcome shows as a red-classed outcome badge.
    expect(html).toContain('outcome error');
    // The Bash step dominates the time share.
    expect(html).toMatch(/share-fill/);
  });

  it('an empty trajectory still renders a valid page (no crash)', () => {
    const html = renderTrajectoryHtml(buildTrajectory([], meta({ agent: 'openclaw' })));
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Where the time went');
  });
});
