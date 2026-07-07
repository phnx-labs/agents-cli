import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readClaudeSessionName, resetSessionNameCache } from './sessionName';

let tmpDir: string;

beforeEach(() => {
  resetSessionNameCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionName-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSessionFile(pid: number, body: object): void {
  fs.writeFileSync(path.join(tmpDir, `${pid}.json`), JSON.stringify(body));
}

describe('readClaudeSessionName', () => {
  it('returns null for empty sessionId', async () => {
    expect(await readClaudeSessionName('', { sessionsDirs: [tmpDir] })).toBeNull();
  });

  it('returns null when sessions dir does not exist', async () => {
    const res = await readClaudeSessionName('abc', {
      sessionsDirs: [path.join(tmpDir, 'does-not-exist')],
    });
    expect(res).toBeNull();
  });

  it('merges across multiple session dirs (multi-version agents-cli layout)', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionName-other-'));
    try {
      fs.writeFileSync(
        path.join(otherDir, '9999.json'),
        JSON.stringify({ sessionId: 'version-b-sid', name: 'Title in version B' })
      );
      writeSessionFile(1111, { sessionId: 'version-a-sid', name: 'Title in version A' });

      const a = await readClaudeSessionName('version-a-sid', { sessionsDirs: [tmpDir, otherDir] });
      resetSessionNameCache();
      const b = await readClaudeSessionName('version-b-sid', { sessionsDirs: [tmpDir, otherDir] });
      expect(a).toBe('Title in version A');
      expect(b).toBe('Title in version B');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('returns name when sessionId matches a file with non-null name', async () => {
    writeSessionFile(66280, { sessionId: 'abc-123', name: 'Fix Touch ID for agents' });
    const res = await readClaudeSessionName('abc-123', { sessionsDirs: [tmpDir] });
    expect(res).toBe('Fix Touch ID for agents');
  });

  it('returns null when matching file has null name', async () => {
    writeSessionFile(66280, { sessionId: 'abc-123', name: null });
    const res = await readClaudeSessionName('abc-123', { sessionsDirs: [tmpDir] });
    expect(res).toBeNull();
  });

  it('returns null when matching file has empty/whitespace name', async () => {
    writeSessionFile(66280, { sessionId: 'abc-123', name: '   ' });
    const res = await readClaudeSessionName('abc-123', { sessionsDirs: [tmpDir] });
    expect(res).toBeNull();
  });

  it('ignores files with non-matching sessionId', async () => {
    writeSessionFile(11111, { sessionId: 'other-id', name: 'Other task' });
    writeSessionFile(22222, { sessionId: 'abc-123', name: 'Wanted task' });
    const res = await readClaudeSessionName('abc-123', { sessionsDirs: [tmpDir] });
    expect(res).toBe('Wanted task');
  });

  it('survives malformed JSON files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{not valid json');
    writeSessionFile(22222, { sessionId: 'abc-123', name: 'Good task' });
    const res = await readClaudeSessionName('abc-123', { sessionsDirs: [tmpDir] });
    expect(res).toBe('Good task');
  });

  it('trims surrounding whitespace from name', async () => {
    writeSessionFile(33333, { sessionId: 'sid', name: '  Spaced title  ' });
    const res = await readClaudeSessionName('sid', { sessionsDirs: [tmpDir] });
    expect(res).toBe('Spaced title');
  });

  it('caches scans within the TTL window', async () => {
    writeSessionFile(44444, { sessionId: 'sid', name: 'First' });
    const t0 = 1_000_000;
    const first = await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 });
    expect(first).toBe('First');

    // Mutate the file. Within TTL, cached value should still be returned.
    writeSessionFile(44444, { sessionId: 'sid', name: 'Second' });
    const second = await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 + 1_000 });
    expect(second).toBe('First');

    // Past TTL, a fresh scan picks up the new value.
    const third = await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 + 60_000 });
    expect(third).toBe('Second');
  });
});
