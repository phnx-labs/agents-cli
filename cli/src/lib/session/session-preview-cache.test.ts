import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('session preview durable cache', () => {
  it('reuses only the exact transcript bytes that produced the digest', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-cache-'));
    try {
      const script = [
        "const db = await import('./src/lib/session/db.ts');",
        "db.writeSessionPreviewCache({ id: 'abc12345', fileMtimeMs: 10, fileSize: 20, preview: { errorCount: 2 } });",
        "const hit = db.readSessionPreviewCache('abc12345', { fileMtimeMs: 10, fileSize: 20 });",
        "const changedSize = db.readSessionPreviewCache('abc12345', { fileMtimeMs: 10, fileSize: 21 });",
        "const changedMtime = db.readSessionPreviewCache('abc12345', { fileMtimeMs: 11, fileSize: 20 });",
        "db.closeDB(); process.stdout.write(JSON.stringify({ hit, changedSize, changedMtime }));",
      ].join(' ');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ hit: { errorCount: 2 } });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
