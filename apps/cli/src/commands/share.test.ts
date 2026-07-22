import { describe, expect, it } from 'vitest';
import { formatSharePublishResult } from './share.js';

describe('formatSharePublishResult', () => {
  it('emits stable JSON for plan-render hooks and scripts', () => {
    const text = formatSharePublishResult(
      {
        url: 'https://share.example/plan',
        coverUrl: 'https://share.example/plan.png',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      true,
    );

    expect(JSON.parse(text)).toEqual({
      url: 'https://share.example/plan',
      coverUrl: 'https://share.example/plan.png',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('keeps the first human output line as the share URL', () => {
    const text = formatSharePublishResult({ url: 'https://share.example/plan' });

    expect(text.split('\n')[0]).toBe('https://share.example/plan');
  });
});
