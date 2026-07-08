import { describe, expect, it } from 'vitest';
import { validateArtifactActions, type ArtifactAction } from '../src/lib/artifact-actions.js';

describe('validateArtifactActions', () => {
  const applicationTools = new Set(['twitter_post', 'email_send', 'clipboard_copy']);
  const httpToolNames = new Set(['custom_api']);

  it('validates valid action', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'twitter_post',
        label: 'Post to Twitter',
        matches: ['tweet', 'social-post'],
        input: {
          text: '{{artifact.content}}',
        },
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toHaveLength(0);
  });

  it('requires tool field', () => {
    const actions: ArtifactAction[] = [
      {
        tool: '',
        label: 'Post',
        matches: ['tweet'],
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toContain('artifact_actions[0]: tool is required');
  });

  it('validates unknown tool', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'unknown_tool',
        label: 'Do Something',
        matches: ['artifact'],
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toContain("artifact_actions[0]: unknown application tool 'unknown_tool'");
  });

  it('accepts http tools', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'custom_api',
        label: 'Call API',
        matches: ['data'],
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toHaveLength(0);
  });

  it('requires label field', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'twitter_post',
        label: '',
        matches: ['tweet'],
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toContain('artifact_actions[0]: label is required');
  });

  it('requires matches field', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'twitter_post',
        label: 'Post',
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toContain('artifact_actions[0]: matches is required (list of artifact labels/patterns)');
  });

  it('validates template variables in input', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'twitter_post',
        label: 'Post',
        matches: ['tweet'],
        input: {
          text: '{{invalid.field}}',
        },
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors.some(e => e.includes('invalid template variable'))).toBe(true);
  });

  it('allows artifact and preflight template variables', () => {
    const actions: ArtifactAction[] = [
      {
        tool: 'twitter_post',
        label: 'Post',
        matches: ['tweet'],
        input: {
          text: '{{artifact.content}} - {{preflight.username}}',
        },
      },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toHaveLength(0);
  });

  it('validates multiple actions', () => {
    const actions: ArtifactAction[] = [
      { tool: '', label: 'A', matches: ['a'] },
      { tool: 'twitter_post', label: '', matches: ['b'] },
      { tool: 'twitter_post', label: 'C' },
    ];

    const errors = validateArtifactActions(actions, httpToolNames, applicationTools);
    expect(errors).toHaveLength(3);
  });
});
