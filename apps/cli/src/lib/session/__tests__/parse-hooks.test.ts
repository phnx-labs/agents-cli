import { describe, expect, test } from 'vitest';
import { parseClaudeContent } from '../parse.js';

/**
 * Claude records every hook firing as a top-level `attachment` line whose
 * payload is `{type: "hook_success"|"hook_error"|…, hookName, hookEvent, …}`.
 * The parser turns each firing into a normalized `hook` event; the derivative
 * `hook_additional_context` record (same firing, shared toolUseID) is skipped
 * so counts are per-firing, not per-record.
 */
describe('Claude hook attachment parsing', () => {
  const line = (att: Record<string, unknown>) =>
    JSON.stringify({ type: 'attachment', timestamp: '2026-08-03T09:21:15Z', attachment: att });

  test('hook_success becomes a hook event with name, lifecycle event, success', () => {
    const events = parseClaudeContent(
      line({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', exitCode: 0 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'hook',
      agent: 'claude',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      success: true,
    });
  });

  test('non-success hook records (hook_error, hook_blocked) are failures', () => {
    const events = parseClaudeContent(
      [
        line({ type: 'hook_error', hookName: 'PreToolUse:git-guard', hookEvent: 'PreToolUse', exitCode: 2 }),
        line({ type: 'hook_blocked', hookName: 'PreToolUse:rm-guard', hookEvent: 'PreToolUse' }),
      ].join('\n'),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'hook', hookName: 'PreToolUse:git-guard', success: false });
    expect(events[1]).toMatchObject({ type: 'hook', hookName: 'PreToolUse:rm-guard', success: false });
  });

  test('hook_additional_context is skipped (derivative of the same firing)', () => {
    const events = parseClaudeContent(
      [
        line({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', toolUseID: 't1' }),
        line({ type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', toolUseID: 't1' }),
      ].join('\n'),
    );
    expect(events.filter((e) => e.type === 'hook')).toHaveLength(1);
  });

  test('non-hook attachments are ignored', () => {
    const events = parseClaudeContent(
      line({ type: 'some_other_attachment', foo: 'bar' }),
    );
    expect(events).toHaveLength(0);
  });
});
