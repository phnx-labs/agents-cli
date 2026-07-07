import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { discoverArtifacts, resolveArtifact } from '../src/lib/session/artifacts.js';
import type { SessionMeta } from '../src/lib/session/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMeta(filePath: string): SessionMeta {
  return {
    id: 'test-session-id-0001',
    shortId: 'test0001',
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath,
  };
}

function buildClaudeJSONL(events: object[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

function assistantWithToolUse(
  toolName: string,
  input: Record<string, string>,
  timestamp = '2026-01-01T10:00:00.000Z',
): object {
  return {
    type: 'assistant',
    timestamp,
    message: {
      content: [
        {
          type: 'tool_use',
          id: `tool_${Math.random().toString(36).slice(2, 9)}`,
          name: toolName,
          input,
        },
      ],
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('discoverArtifacts', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-artifacts-test-'));
    tmpFile = path.join(tmpDir, 'out.ts');
    fs.writeFileSync(tmpFile, 'export const x = 1;');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for session with no write events', () => {
    const jsonl = buildClaudeJSONL([
      { type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(0);
  });

  it('extracts artifact from a Write tool_use event', () => {
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Write', { file_path: tmpFile, content: 'x' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].path).toBe(tmpFile);
    expect(artifacts[0].tool).toBe('Write');
    expect(artifacts[0].exists).toBe(true);
    expect(artifacts[0].sizeBytes).toBeGreaterThan(0);
  });

  it('extracts artifact from an Edit tool_use event', () => {
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Edit', { file_path: tmpFile, old_string: 'x', new_string: 'y' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].tool).toBe('Edit');
  });

  it('marks artifact as not existing when file is gone', () => {
    const gonePath = path.join(tmpDir, 'gone.ts');
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Write', { file_path: gonePath, content: 'x' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].exists).toBe(false);
    expect(artifacts[0].sizeBytes).toBeUndefined();
  });

  it('deduplicates same path — keeps latest timestamp', () => {
    const t1 = '2026-01-01T10:00:00.000Z';
    const t2 = '2026-01-01T11:00:00.000Z';
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Write', { file_path: tmpFile, content: 'v1' }, t1),
      assistantWithToolUse('Edit',  { file_path: tmpFile, old_string: 'x', new_string: 'y' }, t2),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].tool).toBe('Edit');
    expect(artifacts[0].timestamp).toBe(t2);
  });

  it('handles multiple distinct paths', () => {
    const file2 = path.join(tmpDir, 'other.ts');
    fs.writeFileSync(file2, 'export const y = 2;');

    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Write', { file_path: tmpFile, content: 'x' }),
      assistantWithToolUse('Write', { file_path: file2,  content: 'y' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(2);
    const paths = artifacts.map(a => a.path);
    expect(paths).toContain(tmpFile);
    expect(paths).toContain(file2);
  });

  it('sets sessionId from meta', () => {
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Write', { file_path: tmpFile, content: 'x' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const meta = makeMeta(sessionFile);
    const artifacts = discoverArtifacts(meta);
    expect(artifacts[0].sessionId).toBe(meta.id);
  });

  it('returns empty array when session file does not exist', () => {
    const artifacts = discoverArtifacts(makeMeta('/nonexistent/path.jsonl'));
    expect(artifacts).toHaveLength(0);
  });

  it('ignores non-write tools like Read and Bash', () => {
    const jsonl = buildClaudeJSONL([
      assistantWithToolUse('Read', { file_path: tmpFile }),
      assistantWithToolUse('Bash', { command: 'ls' }),
    ]);
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, jsonl);

    const artifacts = discoverArtifacts(makeMeta(sessionFile));
    expect(artifacts).toHaveLength(0);
  });
});

describe('resolveArtifact', () => {
  const artifacts = [
    { path: '/workspace/src/foo.ts',     tool: 'Write', timestamp: '', exists: true, sizeBytes: 100, sessionId: 'x' },
    { path: '/workspace/src/bar.ts',     tool: 'Edit',  timestamp: '', exists: true, sizeBytes: 200, sessionId: 'x' },
    { path: '/workspace/tests/foo.test.ts', tool: 'Write', timestamp: '', exists: true, sizeBytes: 50, sessionId: 'x' },
  ];

  it('resolves by exact path', () => {
    const result = resolveArtifact(artifacts, '/workspace/src/foo.ts');
    expect(result?.path).toBe('/workspace/src/foo.ts');
  });

  it('resolves by basename when unique', () => {
    const result = resolveArtifact(artifacts, 'bar.ts');
    expect(result?.path).toBe('/workspace/src/bar.ts');
  });

  it('resolves by basename — returns first match when ambiguous', () => {
    const result = resolveArtifact(artifacts, 'foo.ts');
    expect(result).not.toBeNull();
  });

  it('resolves by path suffix', () => {
    const result = resolveArtifact(artifacts, 'src/bar.ts');
    expect(result?.path).toBe('/workspace/src/bar.ts');
  });

  it('returns null when no match', () => {
    const result = resolveArtifact(artifacts, 'nonexistent.ts');
    expect(result).toBeNull();
  });

  it('returns null for empty artifact list', () => {
    expect(resolveArtifact([], 'foo.ts')).toBeNull();
  });
});
