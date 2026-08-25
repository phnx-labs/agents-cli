import { describe, expect, it } from 'vitest';

import { importAgentConfig, isValidImportVersion } from './import.js';

describe('isValidImportVersion', () => {
  it.each(['1.0.0; rm -rf /', '../../etc'])('rejects invalid version %j', (version) => {
    expect(isValidImportVersion(version)).toBe(false);
  });

  it.each(['2.1.140', 'latest'])('accepts valid version %j', (version) => {
    expect(isValidImportVersion(version)).toBe(true);
  });
});

describe('importAgentConfig version validation', () => {
  it('rejects invalid versions at the function boundary', async () => {
    await expect(importAgentConfig('claude', '1.0.0; rm -rf /')).resolves.toMatchObject({
      success: false,
      error: 'Invalid version: "1.0.0; rm -rf /"',
    });
  });
});
