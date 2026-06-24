import { describe, it, expect } from 'vitest';
import { planUmbrellaStages } from './sync-umbrella.js';

/**
 * The flag matrix for the umbrella `agents sync` verb. This is the bug-prone
 * part (which stages run for which flags); the I/O executor wraps existing
 * tested library functions.
 */
describe('planUmbrellaStages', () => {
  it('bare: fetch all three, then reconcile', () => {
    expect(planUmbrellaStages({})).toEqual({
      fetchRepos: true, fetchSecrets: true, fetchSessions: true, reconcile: true,
    });
  });

  it('--local: reconcile only, no fetch', () => {
    expect(planUmbrellaStages({ local: true })).toEqual({
      fetchRepos: false, fetchSecrets: false, fetchSessions: false, reconcile: true,
    });
  });

  it('--local wins even if other flags are set', () => {
    expect(planUmbrellaStages({ local: true, repos: true, cloud: true })).toEqual({
      fetchRepos: false, fetchSecrets: false, fetchSessions: false, reconcile: true,
    });
  });

  it('--cloud: fetch all three, skip reconcile', () => {
    expect(planUmbrellaStages({ cloud: true })).toEqual({
      fetchRepos: true, fetchSecrets: true, fetchSessions: true, reconcile: false,
    });
  });

  it('single selector (--sessions): fetch only that, then reconcile', () => {
    expect(planUmbrellaStages({ sessions: true })).toEqual({
      fetchRepos: false, fetchSecrets: false, fetchSessions: true, reconcile: true,
    });
  });

  it('multiple selectors: fetch exactly those, then reconcile', () => {
    expect(planUmbrellaStages({ repos: true, secrets: true })).toEqual({
      fetchRepos: true, fetchSecrets: true, fetchSessions: false, reconcile: true,
    });
  });

  it('selector + --cloud: fetch only the selected, skip reconcile', () => {
    expect(planUmbrellaStages({ repos: true, cloud: true })).toEqual({
      fetchRepos: true, fetchSecrets: false, fetchSessions: false, reconcile: false,
    });
  });
});
