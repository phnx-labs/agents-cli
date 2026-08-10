import { describe, test, expect } from 'bun:test';
import { resolvePdfEngine, buildPdfArgs } from './pdfEngine';

describe('resolvePdfEngine', () => {
  test('returns chrome when first chrome candidate exists', () => {
    const engine = resolvePdfEngine({
      exists: (p) => p === '/fake/chrome',
      chromeCandidates: ['/fake/chrome', '/fake/other-chrome'],
      princeCandidates: ['/fake/prince'],
    });
    expect(engine).toEqual({ kind: 'chrome', binary: '/fake/chrome' });
  });

  test('falls back to second chrome candidate', () => {
    const engine = resolvePdfEngine({
      exists: (p) => p === '/fake/chromium',
      chromeCandidates: ['/fake/chrome', '/fake/chromium'],
      princeCandidates: [],
    });
    expect(engine).toEqual({ kind: 'chrome', binary: '/fake/chromium' });
  });

  test('falls back to prince when no chrome found', () => {
    const engine = resolvePdfEngine({
      exists: (p) => p === '/fake/prince',
      chromeCandidates: ['/fake/chrome'],
      princeCandidates: ['/fake/prince'],
    });
    expect(engine).toEqual({ kind: 'prince', binary: '/fake/prince' });
  });

  test('prefers chrome over prince when both present', () => {
    const engine = resolvePdfEngine({
      exists: () => true,
      chromeCandidates: ['/fake/chrome'],
      princeCandidates: ['/fake/prince'],
    });
    expect(engine).toEqual({ kind: 'chrome', binary: '/fake/chrome' });
  });

  test('returns null when no engine found', () => {
    const engine = resolvePdfEngine({
      exists: () => false,
      chromeCandidates: ['/fake/chrome'],
      princeCandidates: ['/fake/prince'],
    });
    expect(engine).toBeNull();
  });
});

describe('buildPdfArgs', () => {
  test('chrome args include print-to-pdf and file url', () => {
    const args = buildPdfArgs(
      { kind: 'chrome', binary: '/x' },
      '/tmp/in.html',
      '/out/file.pdf',
    );
    expect(args).toContain('--headless=new');
    expect(args).toContain('--print-to-pdf=/out/file.pdf');
    expect(args).toContain('file:///tmp/in.html');
  });

  test('prince args are positional', () => {
    const args = buildPdfArgs(
      { kind: 'prince', binary: '/x' },
      '/tmp/in.html',
      '/out/file.pdf',
    );
    expect(args).toEqual(['/tmp/in.html', '-o', '/out/file.pdf']);
  });
});
