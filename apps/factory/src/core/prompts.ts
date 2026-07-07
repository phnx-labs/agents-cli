// Pure prompts I/O functions (no VS Code dependencies - testable)

import * as fs from 'fs';
import * as path from 'path';
import { PromptEntry } from './settings';

// Built-in default prompts
export const DEFAULT_PROMPTS: PromptEntry[] = [
  {
    id: 'builtin-rethink',
    title: 'rethink',
    content: 'But before we go ahead and make this change, what do you think? Is this the right direction for our product? Reread any relevant files and recall our philosophy and see if making this choice brings us closer to our goal.',
    isFavorite: true,
    createdAt: 0,
    updatedAt: 0,
    accessedAt: 0
  },
  {
    id: 'builtin-debugit',
    title: 'debugit',
    content: 'Confirm the root cause of these issues by spinning up codex and gemini agents via swarm. You should clearly explain the context of the issues, the app and what the user is observing. Explain why that is problematic from a user experience standpoint. And then ask them to clearly figure out the root cause and explain how fixing that would fix those issues. Do not tell them your solution since we don\'t want to bias their thinking. We want to see if they will independently arrive at the same conclusion or not.',
    isFavorite: true,
    createdAt: 0,
    updatedAt: 0,
    accessedAt: 0
  },
  {
    id: 'builtin-yousure',
    title: 'yousure',
    content: 'Stop and verify what you just claimed. Three-step process:\n\nSTEP 1 — SELF-REFLECT (now, before spawning anything):\nReread your last response. List every factual claim you made. For each one, read the actual code right now and verify it. Be brutally honest — mark each claim as VERIFIED (with file:line proof) or WRONG (with what the code actually says). Do not defend your prior answer — investigate it like someone else wrote it.\n\nSTEP 2 — SWARM VERIFY (after step 1):\nSpawn codex and gemini agents via swarm. Give them the full context: what the user asked, what you claimed, and the relevant file paths. Do NOT share your step 1 results or your conclusions — we don\'t want to bias their analysis. Ask them to independently verify the claims by reading the code themselves and arriving at their own conclusions.\n\nSTEP 3 — SYNTHESIZE (after swarm returns):\nCompare your self-reflection (step 1) with the independent swarm results (step 2). Where all three agree, that\'s the answer. Where they disagree, read the disputed code one more time and resolve with evidence, not majority vote. Present the final verified answer with file:line citations for every claim.',
    isFavorite: true,
    createdAt: 0,
    updatedAt: 0,
    accessedAt: 0
  }
];

/**
 * Read prompts from a JSON file.
 * Returns default prompts if file doesn't exist, is empty, or is corrupted.
 * Automatically migrates old prompts missing accessedAt field.
 */
export function readPromptsFromPath(filePath: string): { prompts: PromptEntry[]; usedDefaults: boolean } {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed) && parsed.length > 0) {
        // Migrate: add accessedAt if missing
        const prompts = parsed.map(p => ({
          ...p,
          accessedAt: p.accessedAt ?? 0
        }));
        return { prompts, usedDefaults: false };
      }
    }
  } catch (err) {
    // File corrupted or invalid JSON - fall through to defaults
    console.error('Failed to read prompts:', err);
  }

  return { prompts: [...DEFAULT_PROMPTS], usedDefaults: true };
}

/**
 * Write prompts to a JSON file.
 * Creates parent directories if they don't exist.
 * Returns true on success, false on failure.
 */
export function writePromptsToPath(filePath: string, prompts: PromptEntry[]): boolean {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(prompts, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to write prompts:', err);
    return false;
  }
}

/**
 * Validate a prompt entry has all required fields.
 */
export function isValidPromptEntry(entry: unknown): entry is PromptEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.title === 'string' &&
    typeof e.content === 'string' &&
    typeof e.isFavorite === 'boolean' &&
    typeof e.createdAt === 'number' &&
    typeof e.updatedAt === 'number' &&
    typeof e.accessedAt === 'number'
  );
}
