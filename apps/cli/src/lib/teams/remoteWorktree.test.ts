/**
 * remotePathExpr is the tilde/$HOME expansion helper whose absence (shellQuote of
 * a `~` path) caused three separate distributed-teams bugs — the log-mirror tail,
 * the .exit sentinel read, and the repo-existence check. Lock its contract in.
 *
 * Contract: a leading `~`/`~/` becomes `"$HOME"` so the REMOTE shell expands it
 * (single-quoting would leave a literal `~`); everything after the tilde, and any
 * non-tilde path, is single-quoted so odd characters stay injection-safe.
 */
import { describe, it, expect } from 'vitest';
import { remotePathExpr } from './remoteWorktree.js';

describe('remotePathExpr', () => {
  it('expands a bare ~ to "$HOME"', () => {
    expect(remotePathExpr('~')).toBe('"$HOME"');
  });

  it('expands ~/x to "$HOME"/<rest> so the host shell resolves it', () => {
    // shellQuote leaves an allowlisted path un-quoted (it needs no quoting), so
    // the rest attaches bare after "$HOME"/ — still a single shell token.
    expect(remotePathExpr('~/.agents/repos/team')).toBe('"$HOME"/.agents/repos/team');
  });

  it('passes an absolute path through unchanged (no tilde, already safe)', () => {
    expect(remotePathExpr('/home/muqsit/src/agents-cli')).toBe('/home/muqsit/src/agents-cli');
  });

  it('passes a relative path through unchanged (no leading tilde)', () => {
    expect(remotePathExpr('src/agents-cli')).toBe('src/agents-cli');
  });

  it('keeps the tilde-suffix injection-safe (single-quotes shell metacharacters)', () => {
    // A ~ path whose remainder carries a metachar must stay quoted after "$HOME".
    expect(remotePathExpr('~/a b;rm -rf')).toBe(`"$HOME"/'a b;rm -rf'`);
  });
});
