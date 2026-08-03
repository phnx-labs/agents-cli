import { describe, expect, it } from 'vitest';
import type { Meta } from '../types.js';
import {
  composeSendText,
  isOwnerAlias,
  readOwnerDest,
  resolveSendEnvelope,
} from './send.js';

const metaWithOwner = {
  notify: { owner: { channel: 'imessage', to: '+18055550100' } },
} as Meta;

const metaEmpty = {} as Meta;

describe('isOwnerAlias', () => {
  it('matches owner case-insensitively', () => {
    expect(isOwnerAlias('owner')).toBe(true);
    expect(isOwnerAlias('Owner')).toBe(true);
    expect(isOwnerAlias(' OWNER ')).toBe(true);
  });
  it('rejects other destinations', () => {
    expect(isOwnerAlias('+1805')).toBe(false);
    expect(isOwnerAlias(undefined)).toBe(false);
    expect(isOwnerAlias('')).toBe(false);
  });
});

describe('composeSendText', () => {
  it('returns trimmed text alone', () => {
    expect(composeSendText('  hello  ')).toBe('hello');
  });
  it('appends urls on new lines', () => {
    expect(composeSendText('see', ['https://a.example', 'https://b.example'])).toBe(
      'see\nhttps://a.example\nhttps://b.example',
    );
  });
  it('skips urls already in the body', () => {
    expect(composeSendText('see https://a.example', ['https://a.example', 'https://b.example'])).toBe(
      'see https://a.example\nhttps://b.example',
    );
  });
  it('allows url-only messages', () => {
    expect(composeSendText('', ['https://a.example'])).toBe('https://a.example');
  });
});

describe('readOwnerDest', () => {
  it('returns channel+to when both set', () => {
    expect(readOwnerDest(metaWithOwner)).toEqual({
      channel: 'imessage',
      to: '+18055550100',
    });
  });
  it('returns null when owner is incomplete', () => {
    expect(readOwnerDest(metaEmpty)).toBeNull();
    expect(readOwnerDest({ notify: { owner: { channel: 'x', to: '' } } } as Meta)).toBeNull();
  });
});

describe('resolveSendEnvelope', () => {
  it('accepts flag-first send with explicit channel and to', () => {
    const r = resolveSendEnvelope(
      { text: 'hi', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({
      text: 'hi',
      channel: 'desktop',
      to: 'local',
    });
  });

  it('accepts positional text for compat', () => {
    const r = resolveSendEnvelope(
      { positionalText: 'legacy', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('legacy');
  });

  it('rejects conflicting positional and --text', () => {
    const r = resolveSendEnvelope(
      { positionalText: 'a', text: 'b', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/once/i);
  });

  it('resolves --to owner from notify.owner', () => {
    const r = resolveSendEnvelope({ text: 'ping', to: 'owner' }, metaWithOwner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.channel).toBe('imessage');
    expect(r.envelope.to).toBe('+18055550100');
  });

  it('ownerMode (notify) defaults to notify.owner', () => {
    const r = resolveSendEnvelope({ text: 'ping', ownerMode: true }, metaWithOwner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({
      channel: 'imessage',
      to: '+18055550100',
      text: 'ping',
    });
  });

  it('lets explicit --channel/--to override owner defaults in ownerMode', () => {
    const r = resolveSendEnvelope(
      { text: 'ping', ownerMode: true, channel: 'desktop', to: 'local' },
      metaWithOwner,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.channel).toBe('desktop');
    expect(r.envelope.to).toBe('local');
  });

  it('ownerMode with full explicit flags works without notify.owner configured', () => {
    // Regression: main allowed `notify --channel desktop --to local` with no yaml.
    const r = resolveSendEnvelope(
      { text: 'fallback', ownerMode: true, channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({ channel: 'desktop', to: 'local', text: 'fallback' });
  });

  it('fills only the missing field from partial notify.owner', () => {
    const partial = { notify: { owner: { channel: 'imessage', to: '' } } } as Meta;
    const r = resolveSendEnvelope(
      { text: 'x', ownerMode: true, to: '+1999' },
      partial,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.channel).toBe('imessage');
    expect(r.envelope.to).toBe('+1999');
  });

  it('fails owner alias when notify.owner is unset', () => {
    const r = resolveSendEnvelope({ text: 'x', to: 'owner' }, metaEmpty);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/notify\.owner|--channel/);
  });

  it('requires channel and to for non-owner destinations', () => {
    const r = resolveSendEnvelope({ text: 'x', to: '+1' }, metaEmpty);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/--channel/);
  });

  it('folds --url into the body', () => {
    const r = resolveSendEnvelope(
      { text: 'plan', channel: 'desktop', to: 'local', urls: ['https://example.com/p'] },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('plan\nhttps://example.com/p');
  });

  it('carries attachments and dryRun', () => {
    const r = resolveSendEnvelope(
      {
        text: 'shot',
        channel: 'desktop',
        to: 'local',
        attachments: ['./a.png'],
        dryRun: true,
      },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.attachments).toEqual(['./a.png']);
    expect(r.envelope.dryRun).toBe(true);
  });

  it('allows url-only body', () => {
    const r = resolveSendEnvelope(
      { channel: 'desktop', to: 'local', urls: ['https://x.test'] },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('https://x.test');
  });
});
