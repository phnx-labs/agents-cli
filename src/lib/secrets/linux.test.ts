import { describe, it, expect } from 'vitest';
import { parseSecretToolItems } from './linux.js';

const PREFIX = 'agents-cli.bundles.';

/**
 * Real `secret-tool search --all service agents-cli` output on libsecret
 * 0.21.4. The crux: the `attribute.*` lines (including `attribute.item`, the
 * only machine-readable item name) are emitted on STDERR, while
 * label/secret/schema land on STDOUT. listSecretToolItems concatenates both
 * streams; these fixtures mirror each stream separately so the regression is
 * pinned to the actual split, not a hand-merged blob.
 */
const STDOUT = [
  '[/5]',
  'label = agents-cli: agents-cli.bundles.demo',
  'secret = {"description":"test","vars":{"API_KEY":{"value":"sk-test"}}}',
  'created = 2026-06-08 23:31:56',
  'modified = 2026-06-08 23:31:57',
  'schema = org.freedesktop.Secret.Generic',
].join('\n');

const STDERR = [
  'attribute.account = muqsit',
  'attribute.service = agents-cli',
  'attribute.item = agents-cli.bundles.demo',
].join('\n');

describe('parseSecretToolItems', () => {
  it('finds items when attribute.item is on stderr (libsecret 0.21.4 split)', () => {
    // stdout alone has no attribute.item line — this is the bug: parsing only
    // stdout returned [] even though the bundle exists.
    expect(parseSecretToolItems(STDOUT, PREFIX)).toEqual([]);
    // The fix concatenates both streams before parsing.
    const combined = `${STDOUT}\n${STDERR}`;
    expect(parseSecretToolItems(combined, PREFIX)).toEqual(['agents-cli.bundles.demo']);
  });

  it('also works when attributes are on stdout (older libsecret)', () => {
    const combined = `${STDOUT}\n${STDERR}\n`;
    expect(parseSecretToolItems(combined, PREFIX)).toContain('agents-cli.bundles.demo');
  });

  it('enumerates multiple items and dedupes', () => {
    const combined = [
      'attribute.item = agents-cli.bundles.alpha',
      'attribute.item = agents-cli.bundles.beta',
      'attribute.item = agents-cli.bundles.alpha',
    ].join('\n');
    expect(parseSecretToolItems(combined, PREFIX)).toEqual([
      'agents-cli.bundles.alpha',
      'agents-cli.bundles.beta',
    ]);
  });

  it('filters by prefix, excluding other services and secret keys', () => {
    const combined = [
      'attribute.item = agents-cli.bundles.demo',
      'attribute.item = agents-cli.secrets.demo.API_KEY',
      'attribute.item = some-other-app.token',
    ].join('\n');
    expect(parseSecretToolItems(combined, PREFIX)).toEqual(['agents-cli.bundles.demo']);
  });

  it('returns [] on empty output', () => {
    expect(parseSecretToolItems('', PREFIX)).toEqual([]);
  });
});
