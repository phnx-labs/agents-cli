import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
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

// POSIX-only: the stub is a `#!/bin/sh` script Windows cannot exec. The product
// code is cross-platform; only this shell-stub harness is not, and the full
// Windows matrix runs on release PRs where the skip is visible. This is the same
// real-executable-on-PATH pattern as `ssh-exec.test.ts` — it drives the actual
// `rush whoami` classifier + exit-code path in `rushSignedIn` with no mocking.
describe.skipIf(process.platform === 'win32')('probeOwnerSink — rush whoami classifier (real PATH stub)', () => {
  const savedHumans = process.env.AGENTS_HUMANS_FILE;
  const imessageMeta = { notify: { owner: { channel: 'imessage', to: '+15550000000' } } } as Meta;

  beforeEach(() => {
    // Isolate the owner dest to the passed meta (no on-disk humans.yaml).
    process.env.AGENTS_HUMANS_FILE = path.join(os.tmpdir(), 'agents-owner-sink-test-absent.yaml');
  });
  afterEach(() => {
    if (savedHumans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = savedHumans;
  });

  // Put a genuine executable named `rush` first on PATH so the probe's
  // `which rush` resolves it and `rush whoami` runs it — a real subprocess round
  // trip that exercises the stdout/stderr classifier and the exit-code branch.
  async function withStubRush<T>(script: string, fn: () => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rushstub-'));
    fs.writeFileSync(path.join(dir, 'rush'), script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = dir + path.delimiter + prevPath;
    try {
      return await fn();
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a signed-in `rush whoami` (exit 0) → reachable, no reason', async () => {
    const s = await withStubRush(
      '#!/bin/sh\nprintf "Logged in as: muqsit@gmail.com\\nSession: valid\\n"\nexit 0\n',
      () => probeOwnerSink(imessageMeta),
    );
    expect(s).toMatchObject({ configured: true, reachable: true, channel: 'imessage', transport: 'imessage' });
    expect(s.reason).toBeUndefined();
  });

  it('an explicit "Not logged in" (exit 0) → unreachable, rush-signed-out', async () => {
    const s = await withStubRush(
      '#!/bin/sh\nprintf "Not logged in\\n"\nexit 0\n',
      () => probeOwnerSink(imessageMeta),
    );
    expect(s).toMatchObject({ configured: true, reachable: false, reason: 'rush-signed-out' });
  });

  it('a signed-out rush that exits non-zero with the message on stderr → rush-signed-out', async () => {
    const s = await withStubRush(
      "#!/bin/sh\nprintf 'not signed in - run rush login\\n' 1>&2\nexit 1\n",
      () => probeOwnerSink(imessageMeta),
    );
    expect(s).toMatchObject({ configured: true, reachable: false, reason: 'rush-signed-out' });
  });

  it('ambiguous whoami output → treated as reachable (does not cry wolf)', async () => {
    const s = await withStubRush(
      '#!/bin/sh\nprintf "rush 0.2.34\\n"\nexit 0\n',
      () => probeOwnerSink(imessageMeta),
    );
    expect(s).toMatchObject({ configured: true, reachable: true });
    expect(s.reason).toBeUndefined();
  });
});
