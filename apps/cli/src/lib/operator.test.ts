import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOperators, getOperator, isKnownOperator, isAdmin, canPerform, isHighConsequenceAllowed } from './operator.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-operator-test-'));
}

function writeOps(root: string, yaml: string): void {
  fs.writeFileSync(path.join(root, 'operators.yaml'), yaml, 'utf-8');
}

describe('operator registry', () => {
  it('returns an empty registry when the file is missing', () => {
    const dir = tmpDir();
    expect(loadOperators(dir)).toEqual({ operators: {} });
  });

  it('loads operators and their capabilities', () => {
    const dir = tmpDir();
    writeOps(dir, `operators:
  muqsit:
    name: Muqsit
    admin: true
  bisma:
    name: Bisma
    can:
      - merge
      - deploy
`);
    const reg = loadOperators(dir);
    expect(Object.keys(reg.operators)).toEqual(['muqsit', 'bisma']);
    expect(isAdmin('muqsit', dir)).toBe(true);
    expect(isAdmin('bisma', dir)).toBe(false);
    expect(canPerform('bisma', 'merge', dir)).toBe(true);
    expect(canPerform('bisma', 'deploy', dir)).toBe(true);
    expect(canPerform('bisma', 'admin', dir)).toBe(false);
  });

  it('requires a known operator for high-consequence blocks', () => {
    const dir = tmpDir();
    writeOps(dir, `operators:
  bisma:
    can:
      - merge
`);
    expect(isHighConsequenceAllowed('merge', 'bisma', dir)).toBe(true);
    expect(isHighConsequenceAllowed('merge', 'stranger', dir)).toBe(false);
    expect(isHighConsequenceAllowed('normal', 'stranger', dir)).toBe(true);
    expect(isHighConsequenceAllowed(undefined, 'stranger', dir)).toBe(true);
  });

  it('admins are allowed any high-consequence action', () => {
    const dir = tmpDir();
    writeOps(dir, `operators:
  boss:
    admin: true
`);
    expect(isHighConsequenceAllowed('deploy', 'boss', dir)).toBe(true);
    expect(isHighConsequenceAllowed('merge', 'boss', dir)).toBe(true);
  });
});
