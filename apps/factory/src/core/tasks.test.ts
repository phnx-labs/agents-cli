import { describe, expect, test } from 'bun:test';
import { buildTaskDispatchPrompt } from './tasks';

describe('buildTaskDispatchPrompt', () => {
  test('builds the task prompt with optional reference, URL, and extra comments', () => {
    expect(buildTaskDispatchPrompt({
      title: 'Fix dispatch modal',
      description: 'Bench dispatch should allow extra user context.',
      identifier: 'SWARM-42',
      url: 'https://linear.app/acme/issue/SWARM-42',
      extraComments: 'Keep the modal open on Bench until the user dispatches.',
    })).toBe([
      'Fix dispatch modal',
      'Bench dispatch should allow extra user context.',
      'Reference: SWARM-42',
      'URL: https://linear.app/acme/issue/SWARM-42',
      'Additional instructions:\nKeep the modal open on Bench until the user dispatches.',
    ].join('\n\n'));
  });

  test('trims blank optional fields without creating empty prompt sections', () => {
    expect(buildTaskDispatchPrompt({
      title: '  Dispatch RUSH-1  ',
      description: '  ',
      identifier: '',
      url: '   ',
      extraComments: '  Prefer Codex for implementation.  ',
    })).toBe('Dispatch RUSH-1\n\nAdditional instructions:\nPrefer Codex for implementation.');
  });
});
