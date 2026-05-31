import { describe, it, expect } from 'vitest';
import { LANDING_HTML } from '../src/landing';

describe('LANDING_HTML required content (EXAMPLE-365 spec)', () => {
  it('has the "open client" lede exactly as the ticket requires', () => {
    expect(LANDING_HTML).toContain(
      'The open client for AI coding agents. Pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron — one interface across Claude, Codex, Gemini, Cursor.'
    );
  });

  it('has the open-stack footer line', () => {
    expect(LANDING_HTML).toContain('open stack for AI coding agents');
    expect(LANDING_HTML).toContain('Cloud runner coming');
  });

  it('shows Chain-agents-in-pipeline section before Pin versions', () => {
    const chainIdx = LANDING_HTML.indexOf('Chain agents in a pipeline');
    const pinIdx = LANDING_HTML.indexOf('Pin versions per project');
    expect(chainIdx).toBeGreaterThan(0);
    expect(pinIdx).toBeGreaterThan(0);
    expect(chainIdx).toBeLessThan(pinIdx);
  });

  it('includes the pipe demo with all three agents', () => {
    expect(LANDING_HTML).toContain('agents run claude');
    expect(LANDING_HTML).toContain('agents run codex');
    expect(LANDING_HTML).toContain('agents run gemini');
  });

  it('includes the .agents repo standardization callout', () => {
    expect(LANDING_HTML).toContain('~/.agents');
    expect(LANDING_HTML).toContain('One config repo, every harness');
  });

  it('install one-liner uses the canonical @phnx-labs scope', () => {
    expect(LANDING_HTML).toContain('@phnx-labs/agents-cli');
    expect(LANDING_HTML).not.toContain('@companion/agents-cli');
    expect(LANDING_HTML).not.toContain('madebyphoenix');
  });

  it('omits the Factory Floor name (not public yet)', () => {
    expect(LANDING_HTML).not.toMatch(/factory\s*floor/i);
  });

  it('has H1 containing the agents wordmark image', () => {
    expect(LANDING_HTML).toMatch(/<h1[^>]*><img[^>]+alt="agents"[^>]*><\/h1>/);
  });
});
