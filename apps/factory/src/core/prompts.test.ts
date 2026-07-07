import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readPromptsFromPath,
  writePromptsToPath,
  isValidPromptEntry,
  DEFAULT_PROMPTS
} from './prompts';
import { PromptEntry } from './settings';

// Test fixtures directory
const TESTDATA_DIR = path.join(__dirname, 'testdata', 'prompts');

// Helper to create a test file path
function testPath(filename: string): string {
  return path.join(TESTDATA_DIR, filename);
}

// Clean up test directory before/after tests
function cleanTestDir(): void {
  if (fs.existsSync(TESTDATA_DIR)) {
    fs.rmSync(TESTDATA_DIR, { recursive: true });
  }
}

describe('prompts I/O', () => {
  beforeEach(() => {
    cleanTestDir();
    fs.mkdirSync(TESTDATA_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanTestDir();
  });

  describe('readPromptsFromPath', () => {
    test('returns defaults when file does not exist', () => {
      const result = readPromptsFromPath(testPath('nonexistent.json'));
      expect(result.usedDefaults).toBe(true);
      expect(result.prompts).toEqual(DEFAULT_PROMPTS);
    });

    test('returns defaults when file is empty', () => {
      const filePath = testPath('empty.json');
      fs.writeFileSync(filePath, '');

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(true);
      expect(result.prompts).toEqual(DEFAULT_PROMPTS);
    });

    test('returns defaults when file contains empty array', () => {
      const filePath = testPath('empty-array.json');
      fs.writeFileSync(filePath, '[]');

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(true);
      expect(result.prompts).toEqual(DEFAULT_PROMPTS);
    });

    test('returns defaults when file contains invalid JSON', () => {
      const filePath = testPath('invalid.json');
      fs.writeFileSync(filePath, '{ not valid json [[[');

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(true);
      expect(result.prompts).toEqual(DEFAULT_PROMPTS);
    });

    test('returns defaults when file contains non-array JSON', () => {
      const filePath = testPath('not-array.json');
      fs.writeFileSync(filePath, '{"key": "value", "other": "data"}');

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(true);
      expect(result.prompts).toEqual(DEFAULT_PROMPTS);
    });

    test('reads valid prompts from file', () => {
      const filePath = testPath('valid.json');
      const prompts: PromptEntry[] = [
        {
          id: 'test-1',
          title: 'Test Prompt',
          content: 'Test content',
          isFavorite: false,
          createdAt: 1000,
          updatedAt: 2000,
          accessedAt: 3000
        }
      ];
      fs.writeFileSync(filePath, JSON.stringify(prompts, null, 2));

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(false);
      expect(result.prompts).toEqual(prompts);
    });

    test('migrates old prompts missing accessedAt field', () => {
      const filePath = testPath('old-format.json');
      const oldPrompts = [{
        id: 'old-prompt',
        title: 'Old Prompt',
        content: 'Old content',
        isFavorite: true,
        createdAt: 1000,
        updatedAt: 2000
      }];
      fs.writeFileSync(filePath, JSON.stringify(oldPrompts, null, 2));

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(false);
      expect(result.prompts[0].accessedAt).toBe(0);
      expect(result.prompts[0].id).toBe('old-prompt');
    });

    test('handles file with multiple entries', () => {
      const filePath = testPath('multiple.json');
      const prompts: PromptEntry[] = [
        {
          id: 'valid-1',
          title: 'Valid',
          content: 'Content',
          isFavorite: false,
          createdAt: 1000,
          updatedAt: 2000,
          accessedAt: 3000
        },
        {
          id: 'valid-2',
          title: 'Valid 2',
          content: 'Content 2',
          isFavorite: true,
          createdAt: 1000,
          updatedAt: 2000,
          accessedAt: 4000
        }
      ];
      fs.writeFileSync(filePath, JSON.stringify(prompts, null, 2));

      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(false);
      expect(result.prompts.length).toBe(2);
    });
  });

  describe('writePromptsToPath', () => {
    test('creates directory if it does not exist', () => {
      const filePath = testPath('nested/deep/prompts.json');
      const prompts: PromptEntry[] = [{
        id: 'test',
        title: 'Test',
        content: 'Content',
        isFavorite: false,
        createdAt: 1000,
        updatedAt: 2000,
        accessedAt: 3000
      }];

      const success = writePromptsToPath(filePath, prompts);
      expect(success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test('writes valid JSON that can be read back', () => {
      const filePath = testPath('roundtrip.json');
      const prompts: PromptEntry[] = [
        {
          id: 'prompt-1',
          title: 'First Prompt',
          content: 'Content with\nmultiple lines\nand special chars: ${}[]',
          isFavorite: true,
          createdAt: 1000,
          updatedAt: 2000,
          accessedAt: 3000
        },
        {
          id: 'prompt-2',
          title: 'Second Prompt',
          content: 'Simple content',
          isFavorite: false,
          createdAt: 4000,
          updatedAt: 5000,
          accessedAt: 6000
        }
      ];

      writePromptsToPath(filePath, prompts);
      const result = readPromptsFromPath(filePath);

      expect(result.usedDefaults).toBe(false);
      expect(result.prompts).toEqual(prompts);
    });

    test('overwrites existing file', () => {
      const filePath = testPath('overwrite.json');

      // Write initial
      writePromptsToPath(filePath, [{
        id: 'old',
        title: 'Old',
        content: 'Old content',
        isFavorite: false,
        createdAt: 1000,
        updatedAt: 2000,
        accessedAt: 3000
      }]);

      // Write new
      const newPrompts: PromptEntry[] = [{
        id: 'new',
        title: 'New',
        content: 'New content',
        isFavorite: true,
        createdAt: 4000,
        updatedAt: 5000,
        accessedAt: 6000
      }];
      writePromptsToPath(filePath, newPrompts);

      const result = readPromptsFromPath(filePath);
      expect(result.prompts.length).toBe(1);
      expect(result.prompts[0].id).toBe('new');
    });

    test('writes empty array successfully', () => {
      const filePath = testPath('empty-write.json');
      const success = writePromptsToPath(filePath, []);
      expect(success).toBe(true);

      // Reading empty array should return defaults
      const result = readPromptsFromPath(filePath);
      expect(result.usedDefaults).toBe(true);
    });

    test('returns false on write failure (invalid path)', () => {
      // Try to write to a path that doesn't exist with a non-creatable parent
      // Use a deeply nested path under a file (not directory) which should fail
      const tempFile = path.join(os.tmpdir(), `test-file-${Date.now()}.txt`);
      fs.writeFileSync(tempFile, 'test');
      const invalidPath = path.join(tempFile, 'nested', 'invalid', 'prompts.json');
      const success = writePromptsToPath(invalidPath, DEFAULT_PROMPTS);
      expect(success).toBe(false);
      fs.unlinkSync(tempFile);
    });
  });

  describe('isValidPromptEntry', () => {
    test('validates complete prompt entry', () => {
      const valid: PromptEntry = {
        id: 'test',
        title: 'Test',
        content: 'Content',
        isFavorite: false,
        createdAt: 1000,
        updatedAt: 2000,
        accessedAt: 3000
      };
      expect(isValidPromptEntry(valid)).toBe(true);
    });

    test('rejects null', () => {
      expect(isValidPromptEntry(null)).toBe(false);
    });

    test('rejects undefined', () => {
      expect(isValidPromptEntry(undefined)).toBe(false);
    });

    test('rejects non-object', () => {
      expect(isValidPromptEntry('string')).toBe(false);
      expect(isValidPromptEntry(123)).toBe(false);
      expect(isValidPromptEntry([])).toBe(false);
    });

    test('rejects missing fields', () => {
      expect(isValidPromptEntry({ id: 'test' })).toBe(false);
      expect(isValidPromptEntry({ id: 'test', title: 'Test' })).toBe(false);
      expect(isValidPromptEntry({
        id: 'test',
        title: 'Test',
        content: 'Content',
        isFavorite: false,
        createdAt: 1000,
        updatedAt: 2000
        // missing accessedAt
      })).toBe(false);
    });

    test('rejects wrong field types', () => {
      expect(isValidPromptEntry({
        id: 123, // should be string
        title: 'Test',
        content: 'Content',
        isFavorite: false,
        createdAt: 1000,
        updatedAt: 2000,
        accessedAt: 3000
      })).toBe(false);

      expect(isValidPromptEntry({
        id: 'test',
        title: 'Test',
        content: 'Content',
        isFavorite: 'yes', // should be boolean
        createdAt: 1000,
        updatedAt: 2000,
        accessedAt: 3000
      })).toBe(false);
    });
  });

  describe('DEFAULT_PROMPTS', () => {
    test('contains rethink, debugit, and yousure prompts', () => {
      expect(DEFAULT_PROMPTS.length).toBe(3);
      expect(DEFAULT_PROMPTS.find(p => p.id === 'builtin-rethink')).toBeDefined();
      expect(DEFAULT_PROMPTS.find(p => p.id === 'builtin-debugit')).toBeDefined();
      expect(DEFAULT_PROMPTS.find(p => p.id === 'builtin-yousure')).toBeDefined();
    });

    test('all default prompts are valid', () => {
      for (const prompt of DEFAULT_PROMPTS) {
        expect(isValidPromptEntry(prompt)).toBe(true);
      }
    });

    test('all default prompts are favorites', () => {
      for (const prompt of DEFAULT_PROMPTS) {
        expect(prompt.isFavorite).toBe(true);
      }
    });
  });
});
