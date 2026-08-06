import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { probeOwnerSink } from './owner-sink.js';
import type { Meta } from '../types.js';

// These exercise the REAL probe — no mocking (repo rule). Determinism comes from
// two real levers: point the humans.yaml reader at a nonexistent file so the owner
// destination comes only from the passed `meta`, and (for the rush-backed case)
// neuter PATH so the real `which rush` genuinely fails — which is exactly the
// headless Linux fleet-box scenario RUSH-2262 describes.
describe('probeOwnerSink', () => {
  const savedHumans = process.env.AGENTS_HUMANS_FILE;
  const savedPath = process.env.PATH;

  beforeEach(() => {
    process.env.AGENTS_HUMANS_FILE = path.join(os.tmpdir(), 'agents-owner-sink-test-absent.yaml');
  });
  afterEach(() => {
    if (savedHumans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = savedHumans;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it('reports configured:false when no owner is set (no finding downstream)', async () => {
    const s = await probeOwnerSink({} as Meta);
    expect(s.configured).toBe(false);
    expect(s.reachable).toBe(false);
  });

  it('a rush-backed owner channel with no rush on PATH is unreachable (the Linux-box case)', async () => {
    process.env.PATH = path.join(os.tmpdir(), 'agents-owner-sink-empty-path');
    const meta = { notify: { owner: { channel: 'imessage', to: '+15550000000' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({
      configured: true,
      reachable: false,
      channel: 'imessage',
      transport: 'imessage',
      reason: 'rush-not-on-path',
    });
  });

  it('a non-rush owner transport delivers locally → reachable, no rush probe', async () => {
    const meta = { notify: { owner: { channel: 'desktop', to: 'local' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: true, channel: 'desktop', transport: 'desktop' });
    expect(s.reason).toBeUndefined();
  });

  it('resolves the transport through notify.transports before deciding', async () => {
    // imessage remapped to a non-rush transport → the non-rush (reachable) path,
    // proving the mapping is applied, not the raw channel name.
    const meta = {
      notify: { owner: { channel: 'imessage', to: 'x' }, transports: { imessage: 'desktop' } },
    } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: true, transport: 'desktop' });
  });
});
