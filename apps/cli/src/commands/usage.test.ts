import { describe, expect, it } from 'vitest';

import { ALL_AGENT_IDS, AGENTS } from '../lib/agents.js';
import { agentReportsUsage } from '../lib/usage.js';
import { formatAgentUsage, unsupportedUsageRecord, type AgentUsageRecord } from './usage.js';

describe('usage support gate', () => {
  it('derives command support from every library usage source', () => {
    for (const agentId of ALL_AGENT_IDS) {
      const record = unsupportedUsageRecord(agentId, AGENTS[agentId].name);
      expect(record === null).toBe(agentReportsUsage(agentId));
    }
  });
});

// Locks the text-path output of the collect/format refactor: `formatAgentUsage`
// must render each status branch exactly as the old inline `renderAgentUsage` did,
// so adding `--json` never drifted the human table. Pure over the record — no
// network, no real accounts.
describe('formatAgentUsage', () => {
  it('unsupported → "does not publish usage data"', () => {
    const rec: AgentUsageRecord = { agent: 'gemini', label: 'Gemini', status: 'unsupported' };
    const out = formatAgentUsage(rec);
    expect(out).toContain('Gemini');
    expect(out).toContain('does not publish usage data.');
  });

  it('no-version → "No version installed."', () => {
    const rec: AgentUsageRecord = { agent: 'claude', label: 'Claude', status: 'no-version' };
    const out = formatAgentUsage(rec);
    expect(out).toContain('Claude');
    expect(out).toContain('No version installed.');
  });

  it('not-signed-in → "Not signed in."', () => {
    const rec: AgentUsageRecord = { agent: 'claude', label: 'Claude', status: 'not-signed-in' };
    expect(formatAgentUsage(rec)).toContain('Not signed in.');
  });

  it('ok with empty usage → heading, email, and the no-data line', () => {
    const rec: AgentUsageRecord = {
      agent: 'claude',
      label: 'Claude',
      status: 'ok',
      email: 'user@example.com',
      // Empty UsageInfo: formatUsageSection returns [] when there's no snapshot/error.
      usage: {} as AgentUsageRecord['usage'],
    };
    const out = formatAgentUsage(rec);
    expect(out).toContain('Claude');
    expect(out).toContain('user@example.com');
    expect(out).toContain('No usage data available right now.');
  });

  it('ok without email → omits the email line but still renders', () => {
    const rec: AgentUsageRecord = {
      agent: 'claude',
      label: 'Claude',
      status: 'ok',
      usage: {} as AgentUsageRecord['usage'],
    };
    const out = formatAgentUsage(rec);
    expect(out).toContain('Claude');
    expect(out).toContain('No usage data available right now.');
  });
});
