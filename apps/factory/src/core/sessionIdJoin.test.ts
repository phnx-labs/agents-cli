import { describe, test, expect } from 'bun:test';
import {
  parseActiveSessionJoinRows,
  sessionIdForTerminalId,
  terminalIdToSessionIdMap,
} from './sessionIdJoin';

describe('sessionIdJoin', () => {
  test('maps terminalId → canonical sessionId', () => {
    const map = terminalIdToSessionIdMap([
      {
        terminalId: 'GK-1',
        sessionId: '019fd199-da69-7c21-9477-5577a6dd725d',
      },
      {
        terminalId: 'CX-2',
        sessionId: 'rollout-2026-08-05T02-03-01-019fd129-6e9f-7082-ad08-9c22de9f1234',
      },
    ]);
    expect(map.get('GK-1')).toBe('019fd199-da69-7c21-9477-5577a6dd725d');
    expect(map.get('CX-2')).toBe('019fd129-6e9f-7082-ad08-9c22de9f1234');
  });

  test('skips rows with no terminalId or no sessionId (no blind first-match)', () => {
    const map = terminalIdToSessionIdMap([
      { sessionId: 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      { terminalId: 'GK-1', sessionId: '' },
      { terminalId: '  ', sessionId: '019fd199-da69-7c21-9477-5577a6dd725d' },
    ]);
    expect(map.size).toBe(0);
  });

  test('sessionIdForTerminalId returns undefined for unknown tabs', () => {
    expect(
      sessionIdForTerminalId(
        [{ terminalId: 'GK-1', sessionId: '019fd199-da69-7c21-9477-5577a6dd725d' }],
        'GK-other',
      ),
    ).toBeUndefined();
  });

  test('parseActiveSessionJoinRows tolerates bad JSON and non-arrays', () => {
    expect(parseActiveSessionJoinRows('not-json')).toEqual([]);
    expect(parseActiveSessionJoinRows('{"sessionId":"x"}')).toEqual([]);
    expect(
      parseActiveSessionJoinRows(
        JSON.stringify([
          { terminalId: 'CD-1', sessionId: '019fd114-4689-7df1-963f-ce06e5a36aeb' },
          null,
          'skip',
        ]),
      ),
    ).toEqual([
      {
        sessionId: '019fd114-4689-7df1-963f-ce06e5a36aeb',
        terminalId: 'CD-1',
        terminal_id: null,
      },
    ]);
  });

  test('accepts terminal_id snake_case from older producers', () => {
    expect(
      sessionIdForTerminalId(
        [{ terminal_id: 'GK-9', sessionId: '019fd199-da69-7c21-9477-5577a6dd725d' }],
        'GK-9',
      ),
    ).toBe('019fd199-da69-7c21-9477-5577a6dd725d');
  });
});
