import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isReapSafe,
  reapSafeOrphans,
  REAP_MIN_IDLE_SECS,
  pickLeaseBundleFromList,
  pickTailscaleBundleFromList,
  crabboxList,
  crabboxWarmup,
  type CrabboxBox,
} from './cli.js';
import type { SecretsBundle } from '../secrets/bundles.js';

describe('pickLeaseBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle that declares a provider token key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('hetzner.com', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('hetzner.com');
  });

  it('matches AWS and DigitalOcean token keys too', () => {
    expect(pickLeaseBundleFromList([bundle('aws', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])])).toBe('aws');
    expect(pickLeaseBundleFromList([bundle('do', ['DIGITALOCEAN_TOKEN'])])).toBe('do');
  });

  it('ignores bundles with no provider token key', () => {
    expect(pickLeaseBundleFromList([bundle('misc', ['OPENAI_API_KEY', 'FOO'])])).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(pickLeaseBundleFromList([])).toBeUndefined();
  });

  it('returns the first match in list order (deterministic)', () => {
    const bundles = [bundle('a', ['HCLOUD_TOKEN']), bundle('b', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('a');
  });
});

describe('pickTailscaleBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle + key that declares a tailscale auth key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('tailnet', ['CRABBOX_TAILSCALE_AUTH_KEY'])];
    expect(pickTailscaleBundleFromList(bundles)).toEqual({ name: 'tailnet', key: 'CRABBOX_TAILSCALE_AUTH_KEY' });
  });

  it('accepts the common alternate key names', () => {
    expect(pickTailscaleBundleFromList([bundle('a', ['TS_AUTHKEY'])])).toEqual({ name: 'a', key: 'TS_AUTHKEY' });
    expect(pickTailscaleBundleFromList([bundle('b', ['TAILSCALE_AUTH_KEY'])])).toEqual({
      name: 'b',
      key: 'TAILSCALE_AUTH_KEY',
    });
  });

  it('returns undefined when no bundle declares one', () => {
    expect(pickTailscaleBundleFromList([bundle('misc', ['HCLOUD_TOKEN'])])).toBeUndefined();
    expect(pickTailscaleBundleFromList([])).toBeUndefined();
  });
});

const NOW = 1_800_000_000; // fixed "now" in unix seconds

function box(over: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: true,
    createdAt: NOW - 10_000,
    expiresAt: NOW - 8_000, // expired by default
    lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 100, // stale by default
    idleTimeoutSecs: 1800,
    ...over,
  };
}

describe('isReapSafe', () => {
  it('reaps a genuine orphan: expired lease AND stale touch', () => {
    expect(isReapSafe(box(), NOW)).toBe(true);
  });

  it('never reaps a box touched within the safety window (TOCTOU guard)', () => {
    // Expired lease, but touched 1 minute ago → a concurrent run may be using it.
    expect(isReapSafe(box({ lastTouchedAt: NOW - 60 }), NOW)).toBe(false);
  });

  it('never reaps a box whose lease has not expired', () => {
    expect(isReapSafe(box({ expiresAt: NOW + 1_000 }), NOW)).toBe(false);
  });

  it('honors max(2×idleTimeout, 1h): a long idle-timeout widens the window', () => {
    // idleTimeout 40m → window = 80m. Touched 70m ago is still inside it.
    const b = box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 70 * 60 });
    expect(isReapSafe(b, NOW)).toBe(false);
    // Touched 90m ago is outside the 80m window.
    expect(isReapSafe(box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 90 * 60 }), NOW)).toBe(true);
  });

  it('never reaps a box with unknown age (null expiresAt or lastTouchedAt)', () => {
    expect(isReapSafe(box({ expiresAt: null }), NOW)).toBe(false);
    expect(isReapSafe(box({ lastTouchedAt: null }), NOW)).toBe(false);
  });
});

describe('reapSafeOrphans', () => {
  it('filters to orphans and sorts most-stale first', () => {
    const fresh = box({ slug: 'fresh', lastTouchedAt: NOW - 30 });          // in use
    const active = box({ slug: 'active', expiresAt: NOW + 500 });           // lease live
    const oldOrphan = box({ slug: 'old', lastTouchedAt: NOW - 100_000 });
    const newOrphan = box({ slug: 'new', lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 10 });
    const out = reapSafeOrphans([fresh, active, newOrphan, oldOrphan], NOW);
    expect(out.map((b) => b.slug)).toEqual(['old', 'new']); // oldest touch first, in-use/active excluded
  });

  it('returns empty when nothing is reap-safe', () => {
    expect(reapSafeOrphans([box({ expiresAt: NOW + 1 })], NOW)).toEqual([]);
  });
});

describe('normalizeBox tailscale fields (via crabboxList)', () => {
  function withFakeCrabbox(listJson: unknown, fn: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-ts-'));
    const listPath = path.join(dir, 'boxes.json');
    fs.writeFileSync(listPath, JSON.stringify(listJson), 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  list) cat "$CRABBOX_LIST"; exit 0 ;;', '  *) exit 1 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    const oldList = process.env.CRABBOX_LIST;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    process.env.CRABBOX_LIST = listPath;
    try {
      fn(dir);
    } finally {
      process.env.PATH = oldPath;
      if (oldList === undefined) delete process.env.CRABBOX_LIST;
      else process.env.CRABBOX_LIST = oldList;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('parses tailscale_ipv4 / tailscale_fqdn from the box labels', () => {
    withFakeCrabbox(
      [
        {
          name: 'crabbox-tailnet',
          status: 'running',
          labels: {
            slug: 'tailnet-one',
            lease: 'cbx_ts',
            state: 'ready',
            tailscale_ipv4: '100.101.102.103',
            tailscale_fqdn: 'tailnet-one.tail1234.ts.net',
          },
          public_net: { ipv4: { ip: '203.0.113.9' } },
        },
      ],
      () => {
        const boxes = crabboxList();
        expect(boxes).toHaveLength(1);
        expect(boxes[0].tailscaleIPv4).toBe('100.101.102.103');
        expect(boxes[0].tailscaleFQDN).toBe('tailnet-one.tail1234.ts.net');
        expect(boxes[0].ip).toBe('203.0.113.9');
      },
    );
  });

  it('leaves tailscale fields undefined for a public-network box', () => {
    withFakeCrabbox(
      [{ name: 'crabbox-pub', status: 'running', labels: { slug: 'pub', lease: 'cbx_p', state: 'ready' } }],
      () => {
        const [b] = crabboxList();
        expect(b.tailscaleIPv4).toBeUndefined();
        expect(b.tailscaleFQDN).toBeUndefined();
      },
    );
  });
});

describe('crabboxWarmup netMode', () => {
  // A fake crabbox that records argv for `warmup` and returns a fresh box on `list`.
  function withRecordingCrabbox(fn: (log: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-warm-'));
    const log = path.join(dir, 'crabbox.log');
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    fs.writeFileSync(before, JSON.stringify([]), 'utf-8');
    fs.writeFileSync(
      after,
      JSON.stringify([
        { name: 'crabbox-new', status: 'running', labels: { slug: 'new', lease: 'cbx_new', state: 'ready' } },
      ]),
      'utf-8',
    );
    // list returns `before` until warmup runs (which flips a marker file), then `after`.
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  warmup) touch "$CRABBOX_DIR/warmed"; echo "leased cbx_new"; exit 0 ;;',
        '  list) if [ -f "$CRABBOX_DIR/warmed" ]; then cat "$CRABBOX_DIR/after.json"; else cat "$CRABBOX_DIR/before.json"; fi; exit 0 ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const old = { PATH: process.env.PATH, CRABBOX_LOG: process.env.CRABBOX_LOG, CRABBOX_DIR: process.env.CRABBOX_DIR };
    process.env.PATH = `${dir}${path.delimiter}${old.PATH ?? ''}`;
    process.env.CRABBOX_LOG = log;
    process.env.CRABBOX_DIR = dir;
    return fn(log).finally(() => {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('adds --network tailscale and -tailscale-tags for a tailscale lease', async () => {
    await withRecordingCrabbox(async (log) => {
      const box = await crabboxWarmup({ netMode: 'tailscale' });
      expect(box.slug).toBe('new');
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).toContain('--network tailscale');
      expect(warmupLine).toContain('-tailscale-tags tag:crabbox');
    });
  });

  it('omits tailscale flags for the default public lease', async () => {
    await withRecordingCrabbox(async (log) => {
      await crabboxWarmup({});
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).not.toContain('tailscale');
    });
  });
});
