import { describe, test, expect } from 'bun:test';
import { mapCloudStatus } from './cloudStatus';

describe('mapCloudStatus', () => {
  test('maps every running-family status', () => {
    for (const s of ['running', 'in_progress', 'queued', 'pending', 'allocating']) {
      expect(mapCloudStatus(s)).toBe('running');
    }
  });

  test('maps every failed-family status', () => {
    for (const s of ['failed', 'error']) {
      expect(mapCloudStatus(s)).toBe('failed');
    }
  });

  test('maps every stopped-family status', () => {
    for (const s of ['cancelled', 'canceled', 'stopped']) {
      expect(mapCloudStatus(s)).toBe('stopped');
    }
  });

  test('maps every completed-family status', () => {
    for (const s of ['completed', 'needs_review']) {
      expect(mapCloudStatus(s)).toBe('completed');
    }
  });

  test('is case-insensitive', () => {
    expect(mapCloudStatus('IN_PROGRESS')).toBe('running');
    expect(mapCloudStatus('Allocating')).toBe('running');
    expect(mapCloudStatus('ERROR')).toBe('failed');
    expect(mapCloudStatus('Cancelled')).toBe('stopped');
    expect(mapCloudStatus('Needs_Review')).toBe('completed');
  });

  test('defaults unknown/empty status to completed', () => {
    expect(mapCloudStatus('')).toBe('completed');
    expect(mapCloudStatus('some-future-status')).toBe('completed');
    expect(mapCloudStatus(undefined as unknown as string)).toBe('completed');
  });
});
