import { describe, expect, test } from 'bun:test';
import {
  buildTaskDispatchPrompt,
  extractImageUrls,
  githubToUnifiedTask,
  linearToUnifiedTask,
} from './tasks';

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

describe('extractImageUrls', () => {
  test('pulls markdown and HTML image URLs, deduped and order-preserving', () => {
    expect(extractImageUrls(
      'intro ![shot](https://uploads.linear.app/a.png) and ![again](https://uploads.linear.app/a.png)',
      'in a comment <img src="https://user-images.githubusercontent.com/b.jpg" alt="x">',
    )).toEqual([
      'https://uploads.linear.app/a.png',
      'https://user-images.githubusercontent.com/b.jpg',
    ]);
  });

  test('ignores non-http(s) URLs (data:/relative) and empty bodies', () => {
    expect(extractImageUrls(
      '![evil](data:image/png;base64,AAAA) ![rel](./local.png)',
      undefined,
      null,
    )).toEqual([]);
  });

  test('strips markdown image titles from the captured URL', () => {
    expect(extractImageUrls('![alt](https://example.com/c.png "a title")')).toEqual([
      'https://example.com/c.png',
    ]);
  });
});

describe('linearToUnifiedTask comments + images', () => {
  test('maps comment author/body and extracts images from description and comments', () => {
    const task = linearToUnifiedTask({
      id: 'iss_1',
      identifier: 'RUSH-9',
      title: 'Broken layout',
      description: 'Repro ![desc](https://uploads.linear.app/desc.png)',
      state: { name: 'In Progress', type: 'started' },
      priority: 2,
      url: 'https://linear.app/acme/issue/RUSH-9',
      comments: {
        nodes: [
          { body: 'Here too ![cmt](https://uploads.linear.app/cmt.png)', createdAt: '2026-07-01T00:00:00Z', user: { name: 'Ada' } },
        ],
      },
    });

    expect(task.metadata.comments).toEqual([
      { body: 'Here too ![cmt](https://uploads.linear.app/cmt.png)', createdAt: '2026-07-01T00:00:00Z', author: 'Ada' },
    ]);
    expect(task.metadata.images).toEqual([
      'https://uploads.linear.app/desc.png',
      'https://uploads.linear.app/cmt.png',
    ]);
  });

  test('leaves images undefined when the body has none', () => {
    const task = linearToUnifiedTask({
      id: 'iss_2',
      identifier: 'RUSH-10',
      title: 'No images',
      description: 'plain text',
      state: { name: 'Todo', type: 'unstarted' },
      priority: 0,
      url: 'https://linear.app/acme/issue/RUSH-10',
    });
    expect(task.metadata.images).toBeUndefined();
  });
});

describe('githubToUnifiedTask images', () => {
  test('extracts image URLs from the issue body', () => {
    const task = githubToUnifiedTask({
      id: 42,
      number: 7,
      title: 'Screenshot bug',
      body: 'See <img src="https://user-images.githubusercontent.com/z.png"> for the glitch.',
      state: 'open',
      html_url: 'https://github.com/acme/repo/issues/7',
    });
    expect(task.metadata.images).toEqual(['https://user-images.githubusercontent.com/z.png']);
  });
});
