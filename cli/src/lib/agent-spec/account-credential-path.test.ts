import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAccountInfo } from './agents.js';
import { slotDir } from '../accounts/slots.js';

describe('resolveAccountCredentialPath — slot first (PHNX-3940 T5)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-cred-'));
  const prevReal = process.env.AGENTS_REAL_HOME;
  const id = `cred-${Date.now()}`;
  const slot = slotDir('grok', id);

  afterEach(() => {
    if (prevReal === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevReal;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(slot, { recursive: true, force: true });
  });

  it('does not inherit another account from AGENTS_REAL_HOME when the home is a slot', async () => {
    process.env.AGENTS_REAL_HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.grok', 'auth.json'), JSON.stringify({ email: 'leaked@example.com' }));
    fs.mkdirSync(path.join(slot, '.grok'), { recursive: true });
    const info = await getAccountInfo('grok', slot);
    expect(info.email).not.toBe('leaked@example.com');
    expect(info.signedIn).toBe(false);
  });
});
