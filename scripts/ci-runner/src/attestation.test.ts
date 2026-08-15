import { describe, expect, test } from 'bun:test';
import { buildUnsigned, signAttestation, verifyAttestation } from './attestation';
import { requestTemplate } from './execute';
import { emptyTimings, type ExecutorRequest } from './types';

describe('attestation', () => {
  test('only the controller key verifies a conclusion', () => {
    const req = requestTemplate({
      owner: 'phnx-labs',
      repo: 'agi-cli',
      checkRunId: 'att-1',
      candidateCommitSha: 'a'.repeat(40),
      candidateTreeSha: 'b'.repeat(40),
    }) as unknown as ExecutorRequest;
    const unsigned = buildUnsigned(req, 'att-1', 0, 'abc', emptyTimings(1));
    const signed = signAttestation(unsigned, 'controller');
    verifyAttestation(signed, 'controller');
    expect(() => verifyAttestation(signed, 'worker-guess')).toThrow(/signature mismatch/);
    expect(() => signAttestation(unsigned, '')).toThrow(/controller signing key is required/);
  });
});
