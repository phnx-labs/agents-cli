import { describe, it, expect } from 'bun:test';
import { generateLabelWithLLM } from './labelgen';

describe('generateLabelWithLLM', () => {
  it('returns null for empty input', async () => {
    expect(await generateLabelWithLLM('')).toBeNull();
    expect(await generateLabelWithLLM(undefined)).toBeNull();
    expect(await generateLabelWithLLM('   \n  ')).toBeNull();
  });

  it('returns a short title for a real task description', async () => {
    const result = await generateLabelWithLLM(
      'Refactor the database connection pool to use lazy initialization. Add a maximum size of 50 and a timeout of 30 seconds.',
      20000
    );
    expect(result).toBeTruthy();
    expect(result!.length).toBeLessThanOrEqual(50);
    expect(result!.split('\n').length).toBe(1);
    expect(result!).not.toMatch(/^["'`]/);
    expect(result!).not.toMatch(/[.!?]$/);
  }, 25000);

  it('returns null when timeout is too short to complete', async () => {
    const result = await generateLabelWithLLM(
      'Build a complete microservices architecture with Kubernetes orchestration and observability.',
      1
    );
    expect(result).toBeNull();
  });
});
