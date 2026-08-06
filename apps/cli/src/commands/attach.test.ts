import { describe, expect, it } from 'vitest';
import { attachRecoveryArgs } from './attach.js';

describe('attachRecoveryArgs', () => {
  it('routes the whole attach action to the origin device', () => {
    expect(attachRecoveryArgs({ id: '14567b8a-db63-4e27-9867-4846813157cc' })).toEqual([
      'sessions',
      'attach',
      '14567b8a-db63-4e27-9867-4846813157cc',
    ]);
  });
});
