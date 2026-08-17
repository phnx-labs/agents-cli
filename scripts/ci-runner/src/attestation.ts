import { createHmac, createHash } from 'node:crypto';
import type { Attestation, ExecutorRequest, Timings } from './types';

export function digestBytes(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function signAttestation(
  payload: Omit<Attestation, 'signature'>,
  controllerKey: string,
): Attestation {
  if (!controllerKey) throw new Error('controller signing key is required');
  const canonical = JSON.stringify(payload);
  const signature = createHmac('sha256', controllerKey).update(canonical).digest('hex');
  return { ...payload, signature };
}

export function verifyAttestation(attestation: Attestation, controllerKey: string): void {
  const { signature, ...payload } = attestation;
  const expected = signAttestation(payload, controllerKey).signature;
  if (signature !== expected) throw new Error('attestation signature mismatch');
}

export function buildUnsigned(
  req: ExecutorRequest,
  runId: string,
  exitCode: number,
  reportDigest: string,
  timings: Timings,
): Omit<Attestation, 'signature'> {
  return {
    runId,
    candidateTreeSha: req.candidateTreeSha,
    candidateCommitSha: req.candidateCommitSha,
    selectionBaseSha: req.selectionBaseSha,
    prHeadSha: req.prHeadSha,
    baseSha: req.baseSha,
    impactPlanDigest: req.impactPlanDigest,
    policyVersion: req.policyVersion,
    exitCode,
    reportDigest,
    timings,
  };
}
