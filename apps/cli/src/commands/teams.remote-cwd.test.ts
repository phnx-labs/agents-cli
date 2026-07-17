/**
 * `teams add --remote-cwd` is a no-op trap: the flag rides the shared --host
 * option family but `teams add` treats --host/--device as placement, so it is
 * never read. Rather than silently ignore it (which misleads you into thinking
 * it set the teammate's repo path), the command rejects it with guidance. These
 * pin the guidance so it can't regress into a bare/empty error.
 */
import { describe, it, expect } from 'vitest';
import { remoteCwdOnAddError } from './teams.js';

describe('remoteCwdOnAddError', () => {
  it('states the flag has no effect on teams add', () => {
    const msg = remoteCwdOnAddError('wave-cli');
    expect(msg).toContain('--remote-cwd');
    expect(msg).toMatch(/no effect on 'teams add'/);
  });

  it('points at --device for placement and create --repo for the code', () => {
    const msg = remoteCwdOnAddError('wave-cli');
    expect(msg).toContain('--device');
    expect(msg).toContain('agents teams create wave-cli --repo');
  });

  it('threads the actual team name into the suggested commands', () => {
    expect(remoteCwdOnAddError('wave-mono')).toContain('agents teams create wave-mono --repo');
    expect(remoteCwdOnAddError('wave-mono')).toContain('agents teams add wave-mono');
  });
});
