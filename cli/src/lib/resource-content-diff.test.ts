import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dirsContentMatch,
  filesContentMatch,
  normalizeResourceContent,
} from './resource-content-diff.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-content-diff-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('normalizeResourceContent', () => {
  it('folds CRLF and trims', () => {
    expect(normalizeResourceContent('a\r\nb\r\n')).toBe('a\nb');
    expect(normalizeResourceContent('  hi  \n')).toBe('hi');
  });
});

describe('filesContentMatch', () => {
  it('matches identical content and ignores trailing-newline/CRLF skew', () => {
    const a = write('a.md', 'hello world\n');
    const b = write('b.md', 'hello world');
    const c = write('c.md', 'hello world\r\n');
    expect(filesContentMatch(a, b)).toBe(true);
    expect(filesContentMatch(a, c)).toBe(true);
  });
  it('reports a real content difference', () => {
    const a = write('a.md', 'hello\n');
    const b = write('b.md', 'goodbye\n');
    expect(filesContentMatch(a, b)).toBe(false);
  });
  it('treats a missing file as a mismatch', () => {
    const a = write('a.md', 'hello\n');
    expect(filesContentMatch(a, path.join(tmp, 'nope.md'))).toBe(false);
  });
});

describe('dirsContentMatch', () => {
  it('matches identical trees and skips ignored entries', () => {
    write('src/SKILL.md', 'skill\n');
    write('src/sub/x.md', 'x\n');
    write('src/.DS_Store', 'junk');
    write('dst/SKILL.md', 'skill\n');
    write('dst/sub/x.md', 'x\n');
    expect(dirsContentMatch(path.join(tmp, 'src'), path.join(tmp, 'dst'))).toBe(true);
  });
  it('detects a nested file content drift', () => {
    write('src/SKILL.md', 'skill\n');
    write('src/sub/x.md', 'NEW\n');
    write('dst/SKILL.md', 'skill\n');
    write('dst/sub/x.md', 'OLD\n');
    expect(dirsContentMatch(path.join(tmp, 'src'), path.join(tmp, 'dst'))).toBe(false);
  });
  it('detects an extra or missing name on either side', () => {
    write('src/a.md', 'a\n');
    write('src/b.md', 'b\n');
    write('dst/a.md', 'a\n');
    expect(dirsContentMatch(path.join(tmp, 'src'), path.join(tmp, 'dst'))).toBe(false);
  });
  it('treats a missing directory as a mismatch', () => {
    write('src/a.md', 'a\n');
    expect(dirsContentMatch(path.join(tmp, 'src'), path.join(tmp, 'gone'))).toBe(false);
  });
});
