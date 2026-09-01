import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeOwnerMessage } from './owner-message.js';
import { _resetLinearWorkspaceCache } from './session/linear.js';

// Real path, no mocks of the composer: composeOwnerMessage resolves the run
// identity from the environment (the same resolver feed post uses) and shapes the
// body through composeBroadcastMessage. We drive identity through env vars — the
// explicit-session branch of resolvePostIdentity — and set a workspace so ticket
// keys resolve. vitest's setup.ts already pins HOME to a private sandbox, so the
// session-index lookup opens an empty db and finds no ticket, exactly the
// "body only NAMES the ticket" case.
const SESSION = '6fc1db18-1111-4222-8333-444455556666';
const saved: Record<string, string | undefined> = {};

function stash(key: string, value: string | undefined) {
  saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  _resetLinearWorkspaceCache();
  stash('LINEAR_WORKSPACE', 'getrush');
  // AGENT_SESSION_ID is checked before AGENTS_SESSION_ID, and the real run this
  // suite executes inside sets it — pin both to the fixture and clear the other
  // identity signals so resolvePostIdentity resolves OUR session deterministically.
  stash('AGENT_SESSION_ID', SESSION);
  stash('AGENTS_SESSION_ID', SESSION);
  stash('AGENTS_MAILBOX_DIR', undefined);
  stash('AGENT_LAUNCH_ID', undefined);
  stash('AGENTS_AGENT_NAME', 'claude');
  stash('AGENTS_MACHINE_ID', 'zion');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetLinearWorkspaceCache();
});

describe('composeOwnerMessage — the shared owner-ping composer (PHNX-3698)', () => {
  it('linkifies a TEAM-N key the body names and appends the tappable console URL', () => {
    const msg = composeOwnerMessage('Deploy never ran. PHNX-3689 is the root cause of the drift.');
    // The prose keeps the plain key; the trail carries the tappable Linear URL.
    expect(msg).toContain('PHNX-3689 is the root cause');
    expect(msg).toContain('https://linear.app/getrush/issue/PHNX-3689');
    // The session crumb becomes a tappable console URL for the full id.
    expect(msg).toContain(`https://prix.dev/console/sessions/${SESSION}`);
  });

  it('with no session in the environment, still linkifies the ticket (no console URL)', () => {
    delete process.env.AGENTS_SESSION_ID;
    delete process.env.AGENT_SESSION_ID;
    delete process.env.AGENTS_MAILBOX_DIR;
    // AGENT_LAUNCH_ID absent → no activity/registry session either; a bare shell
    // run of notify resolves no session. (If the host pid registry happens to map
    // this process, the console URL may appear — assert only the ticket link.)
    const msg = composeOwnerMessage('Heads up on PHNX-3689 before the next deploy.');
    expect(msg).toContain('https://linear.app/getrush/issue/PHNX-3689');
  });

  it('uses a passed title as the scannable head, body below it', () => {
    const msg = composeOwnerMessage('prod is missing the migration.', { title: 'Deploy never ran' });
    expect(msg.startsWith('Deploy never ran')).toBe(true);
    expect(msg).toContain('prod is missing the migration.');
  });
});
