import { describe, expect, it } from 'vitest';
import {
  SHARE_LIFECYCLE_RETENTION_DAYS,
  SHARE_LIFECYCLE_RULE_ID,
  buildShareLifecycleRule,
  mergeShareLifecycleRule,
} from './provision.js';

describe('share bucket lifecycle', () => {
  it('builds the Cloudflare R2 lifecycle rule that deletes old share objects', () => {
    expect(buildShareLifecycleRule()).toEqual({
      id: SHARE_LIFECYCLE_RULE_ID,
      enabled: true,
      conditions: { prefix: '' },
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: SHARE_LIFECYCLE_RETENTION_DAYS * 86400 },
      },
    });
  });

  it('preserves unrelated lifecycle rules and replaces the managed share rule', () => {
    const unrelated = {
      id: 'keep-logs',
      enabled: true,
      conditions: { prefix: 'logs/' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 30 * 86400 } },
    };
    const staleShareRule = {
      id: SHARE_LIFECYCLE_RULE_ID,
      enabled: false,
      conditions: { prefix: '' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 7 * 86400 } },
    };

    expect(mergeShareLifecycleRule([unrelated, staleShareRule])).toEqual([
      unrelated,
      buildShareLifecycleRule(),
    ]);
  });
});
