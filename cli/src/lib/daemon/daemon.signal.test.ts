import { describe, expect, it } from 'vitest';
import { guardSignalHandler } from './daemon.js';

describe.skipIf(process.platform === 'win32')('daemon signal crash barrier', () => {
  it('contains a throwing SIGHUP callback and reports the failure', async () => {
    let reported: unknown;
    const handler = guardSignalHandler(
      () => { throw new Error('reload exploded'); },
      (err) => { reported = err; },
    );
    process.once('SIGHUP', handler);

    process.kill(process.pid, 'SIGHUP');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe('reload exploded');
    process.removeListener('SIGHUP', handler);
  });
});
