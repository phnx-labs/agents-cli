/**
 * The gh overload shim's generated script must be a faithful, self-healing
 * passthrough: recursion-guarded, only intercepting `pr checks`, and degrading to
 * real gh when agents-cli is gone — so a leftover shim can never break `gh`.
 */

import { describe, expect, it } from 'vitest';
import { generateGhOverloadShim, isGhOverloadShim } from './shims.js';
import { generateBrandShim } from './shims.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('generateGhOverloadShim', () => {
  const script = generateGhOverloadShim();

  it('only intercepts `pr checks`, routing it to the hidden __gh verb', () => {
    expect(script).toContain('__gh --real-gh');
    expect(script).toMatch(/\[ "\$1" = "pr" \] && \[ "\$2" = "checks" \]/);
  });

  it('carries a recursion guard (sentinel) and self-heals to real gh', () => {
    expect(script).toContain('AGENTS_GH_SHIM=1');
    // If the sentinel is set OR agents-cli is missing, exec the real gh.
    expect(script).toMatch(/-n "\$AGENTS_GH_SHIM".*\n?.*exec "\$REAL_GH"/s);
    // The default tail passes every non-`pr checks` verb straight to real gh.
    expect(script.trimEnd().endsWith('exec "$REAL_GH" "$@"')).toBe(true);
  });

  it('resolves the real gh from PATH excluding the shims dir', () => {
    expect(script).toContain('find_real_gh');
    expect(script).toContain('"$_d" = "$SHIMS_DIR"');
  });
});

describe('isGhOverloadShim', () => {
  it('recognizes our shim and rejects a brand shim / arbitrary file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
    const ours = path.join(dir, 'gh');
    fs.writeFileSync(ours, generateGhOverloadShim());
    const brand = path.join(dir, 'browser');
    fs.writeFileSync(brand, generateBrandShim('browser'));
    const plain = path.join(dir, 'realgh');
    fs.writeFileSync(plain, '#!/bin/sh\nexec /usr/bin/gh "$@"\n');

    expect(isGhOverloadShim(ours)).toBe(true);
    expect(isGhOverloadShim(brand)).toBe(false);
    expect(isGhOverloadShim(plain)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
