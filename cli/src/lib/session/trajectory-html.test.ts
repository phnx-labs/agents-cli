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

  it('renders the analysis hero + program-aware step list', () => {
    const html = renderTrajectoryHtml(buildTrajectory(events, meta()));
    expect(html).toContain('Where the time went');
    expect(html).toContain('Command mix'); // program mix panel
    expect(html).toContain('id="step-1"');
    expect(html).toContain('exec.ts');
    // Steps are labeled by program via a colored badge (a Bash `bun test` → "bun").
    expect(html).toMatch(/class="badge"[^>]*>bun</);
    // An error step is red-classed and shows its exit code.
    expect(html).toMatch(/class="step error"/);
    expect(html).toContain('exit 1');
    // Time share still renders its bars, now keyed by program.
    expect(html).toMatch(/share-fill/);
  });

  it('ships the analysis-hero CSS in the single-session view (not only in COMPARE_STYLE)', () => {
    // Regression: the .analysis/.card/.mix-*/.slow-* rules once lived in COMPARE_STYLE,
    // so the single-session page (which injects only BASE_STYLE) rendered the hero
    // unstyled — cards had no panels and mix/slow rows jammed ("git105"). The markup
    // being present is not enough; the CSS that lays it out must ship in THIS view.
    const html = renderTrajectoryHtml(buildTrajectory(events, meta()));
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    for (const rule of ['.analysis', '.card', '.mix-row', '.mix-name', '.mix-n', '.slow-row', '.slow-label', '.steps', '.gap-divider']) {
      expect(style, `single-session <style> is missing ${rule}`).toContain(rule);
    }
    // And the grid that actually spaces the command-mix rows must be there.
    expect(style).toMatch(/\.mix-row\s*\{[^}]*display:\s*grid/);
  });

  it('renders a multi-hour idle gap in hours, not runaway minutes', () => {
    // A completed step, then a >1h idle gap — the HTML gap divider (and the KPI)
    // must read "2h05m", not "125m…".
    const overnight: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'b', command: 'git status' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'b', outcome: 'ok' },
      { type: 'message', agent: 'claude', timestamp: '2026-08-01T02:05:01Z', role: 'user', content: 'back' },
    ];
    const html = renderTrajectoryHtml(buildTrajectory(overnight, meta()));
    expect(html).toContain('idle 2h05m'); // the gap divider, in hours
    expect(html).not.toMatch(/idle 125m/); // never runaway minutes
  });

  it('colors every harness shell tool with the shell hue, not just Bash', () => {
    // toolColor now routes through isShellExecTool, so Codex `exec` and Droid `Execute`
    // get the shell bar color (#e0b341) the old `.includes('exec')`/2-name checks split on.
    const shellStep = (tool: string): SessionEvent[] => [
      { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:00Z', tool, callId: 's', command: 'git status' },
      { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:02Z', tool, callId: 's', outcome: 'ok' },
    ];
    // The per-step badge carries the color as `style="background:#e0b341"` — distinct
    // from the static CSS that also mentions `color: #e0b341`, so this is a real marker.
    // `run_shell_command` is the genuine delta for THIS site: the old toolColor heuristic
    // (`bash || shell || .includes('exec') || run_command`) missed it, so reverting to it
    // makes this case fail — exec/Execute/run_command all matched the old check too.
    for (const tool of ['exec', 'Execute', 'run_command', 'run_shell_command']) {
      expect(renderTrajectoryHtml(buildTrajectory(shellStep(tool), meta({ agent: 'codex' }))))
        .toContain('style="background:#e0b341"');
    }
    // A non-shell tool gets the read hue instead, never the shell hue on its badge.
    const readOnly: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Read', callId: 'r', args: { file_path: 'a.ts' } },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Read', callId: 'r', outcome: 'ok' },
    ];
    const readHtml = renderTrajectoryHtml(buildTrajectory(readOnly, meta()));
    expect(readHtml).toContain('style="background:#4a9eff"');
    expect(readHtml).not.toContain('style="background:#e0b341"');
  });

  it('an empty trajectory still renders a valid page (no crash)', () => {
    const html = renderTrajectoryHtml(buildTrajectory([], meta({ agent: 'openclaw' })));
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Where the time went');
  });
});
