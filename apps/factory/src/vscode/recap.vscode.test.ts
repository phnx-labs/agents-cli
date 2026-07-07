import { describe, test, expect } from 'bun:test';
import {
  buildRecapArgv,
  buildRecapPrompt,
  recapSidecarPath,
  stripFrontmatter,
  stripGeminiToml,
  isRecapSupported,
} from './recap.vscode';

describe('recapSidecarPath', () => {
  test('replaces .jsonl extension', () => {
    expect(recapSidecarPath('/foo/bar/abc-123.jsonl'))
      .toBe('/foo/bar/abc-123.recap.md');
  });

  test('replaces .json extension', () => {
    expect(recapSidecarPath('/foo/bar/session.json'))
      .toBe('/foo/bar/session.recap.md');
  });

  test('appends when no extension present', () => {
    expect(recapSidecarPath('/foo/bar/sessdir'))
      .toBe('/foo/bar/sessdir.recap.md');
  });
});

describe('buildRecapPrompt', () => {
  test('embeds path and template body', () => {
    const out = buildRecapPrompt('/abs/path.jsonl', '# Recap\nFacts first.');
    expect(out).toContain('/abs/path.jsonl');
    expect(out).toContain('Facts first.');
    expect(out).toMatch(/Output only the recap markdown/);
  });

  test('still produces a valid prompt with empty template', () => {
    const out = buildRecapPrompt('/abs/path.jsonl', '');
    expect(out).toContain('/abs/path.jsonl');
    expect(out).toMatch(/Output only the recap markdown/);
  });
});

describe('stripFrontmatter', () => {
  test('removes leading YAML block', () => {
    const md = '---\ndescription: x\n---\n# Body\ntext';
    expect(stripFrontmatter(md)).toBe('# Body\ntext');
  });

  test('passes through markdown without frontmatter', () => {
    const md = '# Body\ntext';
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe('stripGeminiToml', () => {
  test('extracts triple-quoted prompt body', () => {
    const toml = 'name = "recap"\nprompt = """\nDo the recap.\nFacts first.\n"""\n';
    expect(stripGeminiToml(toml)).toContain('Do the recap.');
    expect(stripGeminiToml(toml)).toContain('Facts first.');
  });

  test('falls back to single-quoted string', () => {
    const toml = 'name = "recap"\nprompt = "Quick recap"\n';
    expect(stripGeminiToml(toml)).toBe('Quick recap');
  });
});

describe('buildRecapArgv', () => {
  test('pins the version when provided', () => {
    const argv = buildRecapArgv('claude', '2.1.140', '/work', 'PROMPT');
    expect(argv[0]).toBe('run');
    expect(argv[1]).toBe('claude@2.1.140');
    expect(argv).toContain('--headless');
    expect(argv).toContain('--quiet');
    expect(argv).toContain('--mode');
    expect(argv).toContain('plan');
    expect(argv).toContain('--cwd');
    expect(argv).toContain('/work');
    expect(argv[argv.length - 1]).toBe('PROMPT');
  });

  test('omits version when undefined', () => {
    const argv = buildRecapArgv('codex', undefined, '/work', 'PROMPT');
    expect(argv[1]).toBe('codex');
  });
});

describe('isRecapSupported', () => {
  test('accepts the five supported agents', () => {
    expect(isRecapSupported('claude')).toBe(true);
    expect(isRecapSupported('codex')).toBe(true);
    expect(isRecapSupported('gemini')).toBe(true);
    expect(isRecapSupported('cursor')).toBe(true);
    expect(isRecapSupported('copilot')).toBe(true);
  });

  test('rejects unsupported agent types', () => {
    expect(isRecapSupported('opencode')).toBe(false);
    expect(isRecapSupported('shell')).toBe(false);
    expect(isRecapSupported(undefined)).toBe(false);
    expect(isRecapSupported('')).toBe(false);
  });
});
