import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  MaterializeError,
  materializePortableAgent,
  resolveOutputHome,
} from './materialize.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'commands',
  'testdata',
  'portable-agent-package',
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveOutputHome', () => {
  it('rejects a path with a .. segment', () => {
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(MaterializeError);
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(/Path escape/);
  });
});

describe('materializePortableAgent', () => {
  it('writes only under outputHome for claude', () => {
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-lib-'));
    tempDirs.push(outputHome);
    const receipt = materializePortableAgent({
      package: FIXTURE,
      harness: 'claude',
      version: '2.1.0',
      outputHome,
    });
    expect(receipt.harness).toBe('claude');
    expect(receipt.package).toBe('reviewer');
    expect(fs.existsSync(path.join(outputHome, 'agent.yaml'))).toBe(true);
  });

  it('refuses the live ~/.claude directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-lib-home-'));
    tempDirs.push(home);
    const live = path.join(home, '.claude');
    fs.mkdirSync(live);
    expect(() => resolveOutputHome(live, process.cwd(), home)).toThrow(/Path escape/);
  });

  it('throws unsupported-capability for gemini', () => {
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-lib-unsup-'));
    tempDirs.push(outputHome);
    try {
      materializePortableAgent({
        package: FIXTURE,
        harness: 'gemini',
        version: '1.0.0',
        outputHome,
      });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).code).toBe('unsupported-capability');
    }
  });
});
