import { describe, expect, it } from 'vitest';
import { renderAccountList } from './accounts.js';
import type { AgentId } from '../lib/types.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderAccountList', () => {
  const native = [
    { agent: 'codex' as AgentId, name: 'work', display: 'a@gmail.com', versions: ['0.146.0'] },
    { agent: 'codex' as AgentId, name: 'personal', display: 'b@icloud.com', versions: ['0.145.0'] },
    { agent: 'claude' as AgentId, name: undefined, display: 'c@getrush.ai', versions: ['2.1.219'] },
  ];

  it('groups native logins by harness, prints the harness once per group', () => {
    const out = stripAnsi(renderAccountList([], native));
    // harness label appears exactly once per group (continuation rows are blank)
    expect((out.match(/(^|\n)\s{2}codex\b/g) || []).length).toBe(1);
    expect((out.match(/(^|\n)\s{2}claude\b/g) || []).length).toBe(1);
    // both codex accounts are present under the one group
    expect(out).toContain('work');
    expect(out).toContain('personal');
    expect(out).toContain('a@gmail.com');
    expect(out).toContain('b@icloud.com');
  });

  it('shows the selector hints and both sections', () => {
    const out = stripAnsi(renderAccountList([], native));
    expect(out).toContain('Native logins');
    expect(out).toContain('run <harness>#<label>');
    expect(out).toContain('Provider bundles');
    expect(out).toContain('run <harness> --account <name>');
  });

  it('renders an unlabeled login with an em-dash placeholder, not a blank column', () => {
    const out = stripAnsi(renderAccountList([], native));
    expect(out).toContain('—');
    expect(out).toContain('c@getrush.ai');
  });

  it('column-aligns the identity column across a harness group', () => {
    const out = stripAnsi(renderAccountList([], native));
    const rows = out.split('\n').filter(l => /@/.test(l));
    const codexRows = rows.filter(l => /gmail|icloud/.test(l));
    expect(codexRows.length).toBe(2);
    const at0 = codexRows[0].indexOf('@');
    const at1 = codexRows[1].indexOf('@');
    // the two codex identities begin at the same column — proof the columns are padded, not ragged
    expect(codexRows[0].search(/\S+@/)).toBe(codexRows[1].search(/\S+@/));
    expect(at0).toBeGreaterThan(0);
    void at1;
  });

  it('handles an empty fleet without throwing', () => {
    const out = stripAnsi(renderAccountList([], []));
    expect(out).toContain('No signed-in native accounts found.');
    expect(out).toContain('Provider bundles');
  });
});
