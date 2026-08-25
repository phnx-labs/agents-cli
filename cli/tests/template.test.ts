import { describe, expect, it } from 'vitest';
import { resolveTemplate, extractTemplateVariables } from '../src/lib/template.js';

describe('resolveTemplate', () => {
  it('resolves artifact variables', () => {
    const result = resolveTemplate(
      'Hello {{artifact.name}}!',
      { name: 'World' },
      {}
    );
    expect(result).toBe('Hello World!');
  });

  it('resolves preflight string variables', () => {
    const result = resolveTemplate(
      'User: {{preflight.username}}',
      {},
      { username: 'alice' }
    );
    expect(result).toBe('User: alice');
  });

  it('resolves preflight array variables with comma join', () => {
    const result = resolveTemplate(
      'Tags: {{preflight.tags}}',
      {},
      { tags: ['a', 'b', 'c'] }
    );
    expect(result).toBe('Tags: a,b,c');
  });

  it('handles missing artifact variables with empty string', () => {
    const result = resolveTemplate(
      'Hello {{artifact.missing}}!',
      {},
      {}
    );
    expect(result).toBe('Hello !');
  });

  it('handles missing preflight variables with empty string', () => {
    const result = resolveTemplate(
      'User: {{preflight.missing}}',
      {},
      {}
    );
    expect(result).toBe('User: ');
  });

  it('handles null preflight values with empty string', () => {
    const result = resolveTemplate(
      'Value: {{preflight.value}}',
      {},
      { value: null }
    );
    expect(result).toBe('Value: ');
  });

  it('handles non-string non-array preflight values with empty string', () => {
    const result = resolveTemplate(
      'Count: {{preflight.count}}',
      {},
      { count: 42 }
    );
    expect(result).toBe('Count: ');
  });

  it('resolves multiple variables', () => {
    const result = resolveTemplate(
      '{{artifact.title}} by {{preflight.author}} - {{artifact.date}}',
      { title: 'Hello', date: '2024-01-01' },
      { author: 'Alice' }
    );
    expect(result).toBe('Hello by Alice - 2024-01-01');
  });

  it('handles template with no variables', () => {
    const result = resolveTemplate('Just plain text', {}, {});
    expect(result).toBe('Just plain text');
  });

  it('handles empty template', () => {
    const result = resolveTemplate('', { name: 'test' }, { user: 'alice' });
    expect(result).toBe('');
  });
});

describe('extractTemplateVariables', () => {
  it('extracts artifact variables', () => {
    const { artifact, preflight } = extractTemplateVariables('{{artifact.name}} {{artifact.date}}');
    expect(artifact).toEqual(['name', 'date']);
    expect(preflight).toEqual([]);
  });

  it('extracts preflight variables', () => {
    const { artifact, preflight } = extractTemplateVariables('{{preflight.user}} {{preflight.token}}');
    expect(artifact).toEqual([]);
    expect(preflight).toEqual(['user', 'token']);
  });

  it('extracts mixed variables', () => {
    const { artifact, preflight } = extractTemplateVariables(
      '{{artifact.title}} by {{preflight.author}}'
    );
    expect(artifact).toEqual(['title']);
    expect(preflight).toEqual(['author']);
  });

  it('deduplicates repeated variables', () => {
    const { artifact, preflight } = extractTemplateVariables(
      '{{artifact.name}} and {{artifact.name}} again'
    );
    expect(artifact).toEqual(['name']);
    expect(preflight).toEqual([]);
  });

  it('returns empty arrays for no variables', () => {
    const { artifact, preflight } = extractTemplateVariables('plain text');
    expect(artifact).toEqual([]);
    expect(preflight).toEqual([]);
  });

  it('ignores invalid prefixes', () => {
    const { artifact, preflight } = extractTemplateVariables('{{invalid.field}}');
    expect(artifact).toEqual([]);
    expect(preflight).toEqual([]);
  });
});
