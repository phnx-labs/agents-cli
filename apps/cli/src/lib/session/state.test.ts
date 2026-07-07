import { describe, it, expect } from 'vitest';
import type { SessionEvent } from './types.js';
import {
  inferActivity,
  inferSessionState,
  detectWorktree,
  detectTicket,
  extractPrUrl,
  isPrCreateCommand,
  detectDurableSignals,
  detectSpawnedTeam,
  isTicketCreateTool,
  extractCreatedTicket,
} from './state.js';

const now = Date.now();
const fresh = now - 5_000;      // within the 2-min window
const stale = now - 20 * 60_000; // well outside

function msg(role: 'user' | 'assistant', content: string): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: '', role, content };
}
function tool(toolName: string, args: Record<string, any> = {}, command?: string): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: '', tool: toolName, args, command };
}
function toolResult(toolName: string, output: string): SessionEvent {
  return { type: 'tool_result', agent: 'claude', timestamp: '', tool: toolName, success: true, output };
}

describe('inferActivity — waiting signals', () => {
  it('ExitPlanMode as the last event ⇒ waiting / plan_review', () => {
    const s = inferActivity([msg('user', 'plan it'), tool('ExitPlanMode')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('plan_review');
  });

  it('AskUserQuestion as the last event ⇒ waiting / question', () => {
    const s = inferActivity([msg('user', 'go'), tool('AskUserQuestion')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('question');
  });

  it('an answered AskUserQuestion (tool_result after) is no longer waiting', () => {
    const s = inferActivity(
      [tool('AskUserQuestion'), toolResult('AskUserQuestion', 'user picked B'), msg('assistant', 'Proceeding with B.')],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.activity).not.toBe('waiting_input');
  });

  it('assistant message ending in a question ⇒ waiting / question', () => {
    const s = inferActivity([msg('assistant', 'I can do A or B. Which do you prefer?')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('question');
  });

  it('assistant statement (no question) with stale mtime ⇒ idle', () => {
    const s = inferActivity([msg('assistant', 'Done — tests pass.')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('idle');
  });
});

describe('inferActivity — working signals', () => {
  it('pending tool call while fresh ⇒ working', () => {
    const s = inferActivity([msg('user', 'run tests'), tool('Bash', { command: 'bun test' }, 'bun test')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('working');
    expect(s.preview).toContain('bun test');
  });

  it('pending non-plan tool, alive but stale ⇒ waiting / permission', () => {
    const s = inferActivity([tool('Bash', { command: 'rm -rf x' }, 'rm -rf x')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('permission');
  });

  it('a dead process is never working', () => {
    const s = inferActivity([tool('Bash', { command: 'bun test' }, 'bun test')], { pidAlive: false, mtimeMs: fresh });
    expect(s.activity).toBe('idle');
  });

  it('user spoke last and process alive ⇒ working (owes a reply)', () => {
    const s = inferActivity([msg('assistant', 'anything else?'), msg('user', 'yes, add logging')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('working');
  });
});

describe('detectWorktree', () => {
  it('extracts slug + branch from a worktree cwd', () => {
    const wt = detectWorktree('/home/u/repo/.agents/worktrees/tree-view', 'agents/tree-view');
    expect(wt).toEqual({ path: '/home/u/repo/.agents/worktrees/tree-view', slug: 'tree-view', branch: 'agents/tree-view' });
  });
  it('returns undefined for a normal cwd', () => {
    expect(detectWorktree('/home/u/repo', 'main')).toBeUndefined();
  });
});

describe('detectTicket', () => {
  it('finds an uppercase ref in prompt text', () => {
    expect(detectTicket('please fix RUSH-1234 today')?.id).toBe('RUSH-1234');
  });
  it('does not match utf-8 style noise', () => {
    expect(detectTicket('decode the utf-8 bytes')).toBeUndefined();
  });
  it('recovers a ref from a lowercase Linear branch', () => {
    expect(detectTicket(undefined, 'muqsit/rush-1234-fix-thing')?.id).toBe('RUSH-1234');
  });
  it('ignores denylisted keys in branches (sha-256)', () => {
    expect(detectTicket(undefined, 'add-sha-256-hash')).toBeUndefined();
  });
});

describe('PR detection', () => {
  it('recognizes gh pr create commands', () => {
    expect(isPrCreateCommand('gh pr create --fill')).toBe(true);
    expect(isPrCreateCommand('gh pr view 4')).toBe(false);
  });
  it('extracts a PR url + number from output', () => {
    const pr = extractPrUrl('Created: https://github.com/phnx-labs/agents-cli/pull/482');
    expect(pr).toEqual({ url: 'https://github.com/phnx-labs/agents-cli/pull/482', number: 482 });
  });
  it('correlates gh pr create with the following result url', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'gh pr create --fill' }, 'gh pr create --fill'),
      toolResult('Bash', 'https://github.com/phnx-labs/agents-cli/pull/491'),
    ];
    expect(detectDurableSignals(events).pr?.number).toBe(491);
  });

  it('does NOT flag a PR from prose mentioning the command + a URL (no real tool call)', () => {
    // A session that merely discusses PRs (like this one) must not self-report a PR.
    const events: SessionEvent[] = [
      msg('assistant', 'You could run `gh pr create` and it prints https://github.com/x/y/pull/482'),
      msg('user', 'ok'),
    ];
    expect(detectDurableSignals(events).pr).toBeUndefined();
  });
});

describe('detectDurableSignals — produced artifacts', () => {
  it('correlates a Linear create_issue tool with the created ref in its result', () => {
    const events: SessionEvent[] = [
      tool('mcp__claude_ai_Linear__create_issue', { title: 'Fix flaky test' }),
      toolResult('mcp__claude_ai_Linear__create_issue', 'Created issue RUSH-1519 in Rush'),
    ];
    expect(detectDurableSignals(events).createdTickets).toEqual(['RUSH-1519']);
  });
  it('captures a gh issue-create ref and a spawned team from shell commands', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'agents teams create redesign --enable-worktrees' }, 'agents teams create redesign --enable-worktrees'),
      tool('Bash', { command: 'gh issue create --title x' }, 'gh issue create --title x'),
      toolResult('Bash', 'https://github.com/phnx-labs/agents-cli/issues/812'),
    ];
    const sig = detectDurableSignals(events);
    expect(sig.spawnedTeam).toBe('redesign');
    expect(sig.createdTickets).toEqual(['#812']);
  });
  it('leaves artifacts undefined for a session that created nothing', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'gh issue list' }, 'gh issue list'),
      msg('user', 'just browsing'),
    ];
    const sig = detectDurableSignals(events);
    expect(sig.createdTickets).toBeUndefined();
    expect(sig.spawnedTeam).toBeUndefined();
  });
});

describe('ticket false positives', () => {
  it('does NOT treat a regex snippet like [A-Z0-9]-\\d as a ticket', () => {
    expect(detectTicket('the pattern /([A-Z0-9]-\\d)/ matches')).toBeUndefined();
  });
  it('does NOT treat a digit-bearing key like Z0-9 as a ticket', () => {
    expect(detectTicket('bucket Z0-9 rotated')).toBeUndefined();
  });
  it('still detects a real letters-only key', () => {
    expect(detectTicket('working on ENG-42')?.id).toBe('ENG-42');
  });
});

describe('detectSpawnedTeam', () => {
  it('extracts the team name from `agents teams create <name>`', () => {
    expect(detectSpawnedTeam('agents teams create my-feature')).toBe('my-feature');
  });
  it('extracts from the `ag` alias and `add` sub-verb, skipping flags', () => {
    expect(detectSpawnedTeam('ag teams add auth-work claude --name auth --mode edit')).toBe('auth-work');
  });
  it('handles a leading `--enable-worktrees` flag before the name', () => {
    expect(detectSpawnedTeam('agents teams create --enable-worktrees redesign')).toBe('redesign');
  });
  it('returns undefined for a non-spawn teams command', () => {
    expect(detectSpawnedTeam('agents teams list')).toBeUndefined();
    expect(detectSpawnedTeam('git commit -m "teams create fake"')).toBeUndefined();
    expect(detectSpawnedTeam(undefined)).toBeUndefined();
  });
});

describe('created-ticket detection', () => {
  it('flags a Linear create_issue MCP tool by name', () => {
    expect(isTicketCreateTool('mcp__claude_ai_Linear__create_issue', undefined)).toBe(true);
    expect(isTicketCreateTool('mcp__linear__createIssue', undefined)).toBe(true);
  });
  it('flags any shell tool running `gh issue create`', () => {
    expect(isTicketCreateTool('Bash', 'gh issue create --title x')).toBe(true);
    expect(isTicketCreateTool('shell', 'gh issue create --title x')).toBe(true);
  });
  it('does NOT flag unrelated tools/commands', () => {
    expect(isTicketCreateTool('Bash', 'gh issue list')).toBe(false);
    expect(isTicketCreateTool('Read', undefined)).toBe(false);
  });
  it('extracts a Linear key from the create result', () => {
    expect(extractCreatedTicket('Created issue RUSH-1519 (In Progress)')).toBe('RUSH-1519');
  });
  it('extracts a #number from a gh issue-create result URL', () => {
    expect(extractCreatedTicket('https://github.com/phnx-labs/agents-cli/issues/812')).toBe('#812');
  });
  it('returns undefined when the result carries no ticket', () => {
    expect(extractCreatedTicket('done, nothing to report')).toBeUndefined();
    expect(extractCreatedTicket(undefined)).toBeUndefined();
  });
});

describe('inferSessionState — composed', () => {
  it('attaches worktree + ticket + pr alongside activity', () => {
    const events: SessionEvent[] = [
      msg('user', 'ship RUSH-77 in a worktree'),
      tool('Bash', { command: 'gh pr create' }, 'gh pr create'),
      toolResult('Bash', 'https://github.com/x/y/pull/9'),
      msg('assistant', 'Opened the PR. Anything else?'),
    ];
    const s = inferSessionState(events, {
      cwd: '/home/u/repo/.agents/worktrees/rush-77',
      gitBranch: 'agents/rush-77',
      pidAlive: true,
      mtimeMs: stale,
    });
    expect(s.activity).toBe('waiting_input');
    expect(s.pr?.number).toBe(9);
    expect(s.worktree?.slug).toBe('rush-77');
    expect(s.ticket?.id).toBe('RUSH-77');
  });
});
