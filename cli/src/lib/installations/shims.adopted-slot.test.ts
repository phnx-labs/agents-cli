import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentConfigPath, isSymlinkAdoptedHarness, repointAdoptedConfigToHome } from './shims.js';

describe('repointAdoptedConfigToHome (PHNX-3940 T5)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-adopt-'));
  const prevReal = process.env.AGENTS_REAL_HOME;

  afterEach(() => {
    if (prevReal === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevReal;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('repoints the adopted ~/.<config> symlink at the slot under the auth-op lock', () => {
    expect(isSymlinkAdoptedHarness('droid')).toBe(true);
    process.env.AGENTS_REAL_HOME = tmp;
    const slot = path.join(tmp, 'slot-work');
    const other = path.join(tmp, 'slot-other');
    fs.mkdirSync(path.join(other, '.factory'), { recursive: true });
    const configPath = getAgentConfigPath('droid');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(path.join(other, '.factory'), configPath);

    const result = repointAdoptedConfigToHome('droid', slot);
    expect(result.success).toBe(true);
    const target = fs.readlinkSync(configPath);
    expect(path.resolve(path.dirname(configPath), target)).toBe(path.resolve(slot, '.factory'));
    expect(fs.existsSync(path.join(slot, '.factory'))).toBe(true);
  });

  it('is a no-op for env-isolated harnesses', () => {
    expect(repointAdoptedConfigToHome('claude', path.join(tmp, 'ignored')).success).toBe(true);
  });

  it('fails loud when the adopted path is a real directory', () => {
    process.env.AGENTS_REAL_HOME = tmp;
    const configPath = getAgentConfigPath('droid');
    fs.mkdirSync(configPath, { recursive: true });
    const result = repointAdoptedConfigToHome('droid', path.join(tmp, 'slot'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a symlink/);
  });
});
