import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'vitest.config.ts'), 'utf8');

describe('vitest.config unhandled pool errors', () => {
  test('CI and win32 ignore teardown worker-exits; local Linux stays strict', () => {
    expect(SRC).toContain("process.env.CI === 'true'");
    expect(SRC).toContain('dangerouslyIgnoreUnhandledErrors: true');
    expect(SRC).toContain('ignoreUnhandledPoolErrors');
  });
});
