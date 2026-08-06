/**
 * Guard: `docs/secrets.md` must not teach the leak it documents a finding for.
 *
 * RUSH-1968 happened partly because the docs *recommended* the thing `agents
 * doctor` flags — the file-store section called an rc export "Recommended for
 * shared/CI machines" and called a 0600 key file "identical to" it. An operator
 * who followed the docs put a master key into `~/.zshenv` on seven boxes.
 *
 * ## How this guard decides, and why it is not a phrase blocklist
 *
 * Earlier drafts tried to classify English and were defeated three times, each
 * time by ADDING a word rather than removing one:
 *
 *   1. matching the exact sentences that shipped the advice — beaten by rewording;
 *   2. matching danger patterns but skipping any sentence containing a negation —
 *      beaten by `Export … in ~/.zshenv; it is not necessary to configure
 *      anything else.`;
 *   3. per-sentence scanning — beaten by splitting the claim across a period.
 *
 * Three rules came out of that:
 *
 * - **The doc marks its own exceptions.** The passages that legitimately discuss
 *   the master-key export — the warning that forbids it, and `export --host`,
 *   which really does forward the master key to key a remote's own store — are
 *   wrapped in `<!-- docs-hygiene:allow-master-key-discussion -->`. Everything
 *   outside a marked region is held to the rules with no escape hatch, so a new
 *   rc-file mention fails until an author consciously marks it. Region count,
 *   pairing, and size are pinned so the exemption cannot quietly widen.
 * - **Negation is judged per match and must ABUT the claim** (`never prompts`),
 *   not merely appear nearby. `Do not hesitate: set …` does not clear the check.
 * - **The checks are functions over text, and are tested against synthetic
 *   documents**, not only against the real one. Every bypass found in review is
 *   pinned below, so the same class cannot silently return.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SECRETS_DOC = path.join(CLI_ROOT, 'docs', 'secrets.md');

const ALLOW_OPEN = '<!-- docs-hygiene:allow-master-key-discussion';
const ALLOW_CLOSE = '<!-- /docs-hygiene:allow-master-key-discussion -->';

const MASTER_KEY = 'AGENTS_SECRETS_PASSPHRASE';
const SYNC_KEY = 'AGENTS_SYNC_PASSPHRASE';
const LEGACY_PATH = '~/.agents/.cache/secrets/.passphrase';
const CURRENT_PATH = '~/.agents/.secrets-key/passphrase';

/** Heading of the section documenting the file store's own key resolution. */
const FILE_STORE_HEADING = '## Linux: headless servers and the encrypted-file fallback';

function doc(): string {
  return fs.readFileSync(SECRETS_DOC, 'utf-8');
}

// ---------------------------------------------------------------- primitives

/** `text` with every explicitly-marked exception region removed. */
export function stripAllowedRegions(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf(ALLOW_OPEN, i);
    if (open === -1) { out += text.slice(i); break; }
    out += text.slice(i, open);
    const close = text.indexOf(ALLOW_CLOSE, open);
    // An unterminated marker would silently swallow the rest of the file, so it
    // is a hard error rather than a widened exemption.
    if (close === -1) throw new Error(`unterminated ${ALLOW_OPEN} region at offset ${open}`);
    i = close + ALLOW_CLOSE.length;
  }
  return out;
}

/**
 * Matches of `claim` that are not negated, where "negated" means the negation
 * word DIRECTLY abuts the match — `never prompts`, `not asked` — rather than
 * merely appearing within N characters of it.
 *
 * Proximity was the previous rule and it did not establish that the negation
 * governs the claim: `Do not hesitate: set AGENTS_SECRETS_PASSPHRASE …` cleared
 * it. Requiring adjacency means a disclaimer placed anywhere else in the
 * sentence changes nothing.
 */
const NEGATION_TOKEN = /\b(never|not|no|without|neither|instead of|rather than)\b/gi;

/**
 * True when the run of text immediately preceding a claim negates it.
 *
 * Counts negation tokens rather than testing for one, because a single-token
 * test reads a DOUBLE negative as a denial: `do not not set …` and `does not
 * never prompt …` are affirmative, and both cleared the earlier check by adding
 * one word. An odd count negates; an even count does not.
 */
function negatesClaim(abutting: string): boolean {
  const hits = abutting.match(NEGATION_TOKEN) ?? [];
  return hits.length % 2 === 1;
}

/**
 * Matches of `claim` that are not negated, where "negated" means an odd number
 * of negation words DIRECTLY abut the anchor — `never prompts` — rather than
 * merely appearing within N characters of it.
 *
 * Proximity was the original rule and it did not establish that the negation
 * governs the claim: `Do not hesitate: set AGENTS_SECRETS_PASSPHRASE …` cleared
 * it. Requiring adjacency means a disclaimer placed elsewhere in the sentence
 * changes nothing, and only letters and spaces may intervene, so punctuation
 * breaks the association.
 *
 * `anchorGroup` names the capture group carrying the claim's VERB. When the
 * grammar puts the verb last (`the passphrase is not requested`), the negation
 * sits before the verb, not before the match, and anchoring on the match start
 * would report a legitimate denial as an offender.
 */
export function unnegatedMatches(
  text: string,
  claim: RegExp,
  anchorGroup?: number,
): Array<{ text: string; index: number }> {
  const flags = new Set([...claim.flags, 'g', 'd']);
  const re = new RegExp(claim.source, [...flags].join(''));
  const out: Array<{ text: string; index: number }> = [];
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    const groupStart = anchorGroup === undefined
      ? undefined
      : (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> })
        .indices?.[anchorGroup]?.[0];
    const anchor = groupStart ?? at;
    const before = text.slice(Math.max(0, anchor - 32), anchor);
    const abutting = /([A-Za-z ]*)$/.exec(before)?.[1] ?? '';
    if (negatesClaim(abutting)) continue;
    out.push({ text: m[0].replace(/\s+/g, ' ').trim(), index: at });
  }
  return out;
}

// ------------------------------------------------------------------- checks
// Each takes the full document text and returns the offending excerpts.

const RC_FILE = new RegExp(
  String.raw`~/\.(zshenv|zshrc|bashrc|bash_profile|profile)\b|\bshell rc\b|\blogin profile\b` +
  String.raw`|\bshell profile\b|\brc file\b|\.zshenv\b`,
  'i',
);

/** Any rc-file mention outside a marked region. */
export function rcFileMentions(text: string): string[] {
  return stripAllowedRegions(text).split('\n').filter((line) => RC_FILE.test(line));
}

/** Claims that the 0600 key file is the same thing as an env/rc export. */
export function equivalenceClaims(text: string): string[] {
  const equivalence = new RegExp(
    String.raw`\b(identical|equivalent|the same as|no different|no safer|as safe as)\b[\s\S]{0,160}?` +
    String.raw`(\bexport\b|\brc file\b|\bshell rc\b|~/\.zsh|\benvironment variable\b|\benv var\b)`,
    'gi',
  );
  return stripAllowedRegions(text).match(equivalence) ?? [];
}

/** Promises of a passphrase prompt the file store does not have. */
export function promptClaims(text: string): string[] {
  const guardedText = stripAllowedRegions(text);
  const start = guardedText.indexOf(FILE_STORE_HEADING);
  if (start === -1) return ['__FILE_STORE_SECTION_NOT_FOUND__'];
  const next = guardedText.indexOf('\n## ', start + FILE_STORE_HEADING.length);
  const section = next === -1 ? guardedText.slice(start) : guardedText.slice(start, next);

  // Two grammars, checked separately because the negation sits in a different
  // place in each. Verb-first ("asks you for a passphrase") negates before the
  // match; passphrase-first ("the passphrase is not requested") negates before
  // the trailing verb, so that one anchors on its capture group.
  const verbFirst = /\b(prompts?|asks?|asked|requests?|requested|prompted)\b[^.]{0,90}\bpassphrase\b/gi;
  const passphraseFirst = /\bpassphrase\b[^.]{0,60}\b(prompt|requested|asked)\b/gi;
  return [
    ...unnegatedMatches(section, verbFirst),
    ...unnegatedMatches(section, passphraseFirst, 1),
  ].map((m) => m.text);
}

/** Instructions to set the MASTER key so unattended sync works. */
export function headlessSyncInstructions(text: string): string[] {
  const guardedText = stripAllowedRegions(text);
  const instruction = new RegExp(String.raw`\b(set|export|define|configure)\s+\`?${MASTER_KEY}`, 'gi');
  return unnegatedMatches(guardedText, instruction)
    // The index comes from the match itself, so filtering never misaligns a
    // survivor with an earlier match's context (the bug this replaced).
    .filter(({ index }) => {
      const around = guardedText.slice(Math.max(0, index - 300), index + 300);
      return /\b(headless|CI|unattended|no TTY|worker box)\b/i.test(around)
        && /\b(push|pull|sync)\b/i.test(around);
    })
    .map((m) => m.text);
}

/** Legacy-path mentions that read as a live location rather than a fallback. */
export function legacyPathMisuses(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n{2,}/).filter((s) => s.includes(LEGACY_PATH));
  const writeVerb = /\b(written to|write|writes|save|store|stored|place|put|generated (in|at)|active|current)\b/i;
  // Explicit read-only semantics only. The bare word "legacy" is NOT enough —
  // `Use the legacy <path> as the active key location.` satisfied it while
  // presenting the path as live, which is the one-word bypass this closes.
  const readOnlyFraming = /read as a fallback|never written|read-only|read only|no longer written|pre-#479/i;
  return sentences.filter((s) => writeVerb.test(s) || !readOnlyFraming.test(s));
}

/** The one blunt phrase that shipped the original advice. */
export function recommendsForSharedMachines(text: string): boolean {
  return /Recommended for shared\/CI machines/i.test(stripAllowedRegions(text));
}

// -------------------------------------------------------- the real document

describe('docs/secrets.md hygiene (RUSH-1968)', () => {
  it('keeps its exceptions few, small, paired, and reviewed', () => {
    // A marked region is a DELIBERATE override — text inside it is exempt from
    // every check. That is the point (the warning must name what it forbids,
    // and `export --host` really does forward the master key), and it is also
    // the design's soft spot, so it is pinned by count, pairing, and size.
    const text = doc();
    const opens = text.split(ALLOW_OPEN).length - 1;
    const closes = text.split(ALLOW_CLOSE).length - 1;
    expect(opens).toBe(closes);
    expect(opens).toBe(2);

    const sizes: number[] = [];
    let i = 0;
    for (;;) {
      const open = text.indexOf(ALLOW_OPEN, i);
      if (open === -1) break;
      const close = text.indexOf(ALLOW_CLOSE, open);
      sizes.push(close - open);
      i = close + ALLOW_CLOSE.length;
    }
    for (const size of sizes) expect(size).toBeLessThan(1200);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(2000);
  });

  it('never mentions a shell rc file outside a marked region', () => {
    expect(rcFileMentions(doc())).toEqual([]);
  });

  it('never recommends the master passphrase for shared or CI machines', () => {
    expect(recommendsForSharedMachines(doc())).toBe(false);
  });

  it('never equates the 0600 key file with an environment or rc export', () => {
    expect(equivalenceClaims(doc())).toEqual([]);
  });

  it('names the real machine-local key path and never writes to the legacy one', () => {
    expect(doc()).toContain(CURRENT_PATH);
    expect(legacyPathMisuses(doc())).toEqual([]);
  });

  it('does not promise a passphrase prompt that getPassphrase does not have', () => {
    // Scoped to the file-store section on purpose: `secrets push`/`pull` really
    // do prompt, for the TRANSPORT passphrase, a different secret.
    expect(promptClaims(doc())).toEqual([]);
    expect(doc()).toMatch(/\*\*never prompts\*\*/i);
  });

  it('points headless sync at the transport variable, not the master key', () => {
    expect(doc()).toContain(SYNC_KEY);
    expect(headlessSyncInstructions(doc())).toEqual([]);
  });
});

// ------------------------------------------- the checks, against known attacks

/**
 * Every bypass found across four review passes, pinned as a test rather than a
 * shell one-liner someone once ran. A guard whose own weaknesses are not tests
 * regresses to the weakness.
 */
describe('docs-hygiene checks catch the bypasses review found', () => {
  const HEAD = `${FILE_STORE_HEADING}\n\n`;

  it('rejects an rc mention with no variable in the same sentence', () => {
    // An earlier draft filtered to sentences containing the variable, so a
    // two-sentence split slipped through. The check no longer looks for the
    // variable at all — the rc-file token alone is disqualifying — so the
    // assertion is on the offending clause, not merely on non-emptiness.
    const bad = `${HEAD}${MASTER_KEY} controls the store key.\nPersist it in the login profile.\n`;
    // Asserting the offending LINE, not just non-emptiness: the earlier version
    // of this test stayed green with the whole setup removed.
    expect(rcFileMentions(bad)).toEqual(['Persist it in the login profile.']);
  });

  it('rejects an rc instruction that merely contains the word "not"', () => {
    // A sentence-level negation filter skipped this entirely.
    const bad = `${HEAD}Export ${MASTER_KEY} in ~/.zshenv; it is not necessary to configure anything else.\n`;
    expect(rcFileMentions(bad)).not.toEqual([]);
  });

  it('rejects an equivalence claim that appends a negation', () => {
    const bad = `${HEAD}The key file is equivalent to a shell rc export and is not dangerous.\n`;
    expect(equivalenceClaims(bad)).not.toEqual([]);
  });

  it('rejects an equivalence claim split across a period', () => {
    // Per-sentence scanning missed this.
    const bad = `${HEAD}The key file is equivalent. It is just a shell rc export.\n`;
    expect(equivalenceClaims(bad)).not.toEqual([]);
  });

  it('rejects a write instruction to the legacy path that says "old"', () => {
    const bad = `Write the key to the old ${LEGACY_PATH} path.\n`;
    expect(legacyPathMisuses(bad)).not.toEqual([]);
  });

  it('rejects a legacy-path mention with no read-only framing at all', () => {
    const bad = `The machine-local key lives at ${LEGACY_PATH} on this machine.\n`;
    expect(legacyPathMisuses(bad)).not.toEqual([]);
  });

  it('accepts a legacy-path mention framed as a read-only fallback', () => {
    const ok = `The legacy co-located key at ${LEGACY_PATH} is read as a fallback, never written.\n`;
    expect(legacyPathMisuses(ok)).toEqual([]);
  });

  it('rejects the legacy path presented as the ACTIVE location, despite saying "legacy"', () => {
    // Accepting the bare word "legacy" as read-only framing was a one-word
    // bypass: this sentence contains it and no write verb, yet points a reader
    // at the old path as if it were live.
    const bad = `Use the legacy ${LEGACY_PATH} as the active key location.\n`;
    expect(legacyPathMisuses(bad)).not.toEqual([]);
  });

  it('rejects a passive prompt claim', () => {
    const bad = `${HEAD}Interactive sessions are asked for the passphrase.\n`;
    expect(promptClaims(bad)).not.toEqual([]);
  });

  it('rejects a prompt claim that appends an unrelated negation', () => {
    // The per-sentence exclusion cleared this; per-match adjacency does not.
    const bad = `${HEAD}The command asks you for a passphrase; no prompt is needed elsewhere.\n`;
    expect(promptClaims(bad)).not.toEqual([]);
  });

  it('rejects a prompt claim preceded by a negation that does not govern it', () => {
    // Proximity-based negation cleared this: "No" sits within 30 chars of "asks".
    const bad = `${HEAD}No caveat: the command asks for a passphrase.\n`;
    expect(promptClaims(bad)).not.toEqual([]);
  });

  it('accepts a genuine denial where the negation abuts the verb', () => {
    const ok = `${HEAD}It never prompts for a passphrase, on any platform.\n`;
    expect(promptClaims(ok)).toEqual([]);
  });

  it('accepts a passive denial, where the negation abuts the trailing verb', () => {
    // "The passphrase is not requested" puts the verb last, so anchoring the
    // negation on the match START would report a legitimate denial. The
    // passphrase-first grammar anchors on its verb instead.
    const ok = `${HEAD}The passphrase is not requested at any point.\n`;
    expect(promptClaims(ok)).toEqual([]);
  });

  it('rejects a passive prompt claim with no negation', () => {
    // The mirror of the above: the same grammar, affirmative, must still fail.
    const bad = `${HEAD}The passphrase is requested at first use.\n`;
    expect(promptClaims(bad)).not.toEqual([]);
  });

  it('rejects a DOUBLE negative prompt claim', () => {
    // "does not never prompt" is affirmative. A single-token negation test read
    // it as a denial; counting tokens and requiring an odd count does not.
    const bad = `${HEAD}The command does not never prompt for a passphrase.\n`;
    expect(promptClaims(bad)).not.toEqual([]);
  });

  it('rejects a headless-sync instruction', () => {
    const bad = `On a headless CI box, set ${MASTER_KEY} so push and pull work.\n`;
    expect(headlessSyncInstructions(bad)).not.toEqual([]);
  });

  it('rejects a headless-sync instruction that appends "this is opt-in"', () => {
    const bad = `On a headless CI box, set ${MASTER_KEY} so push and pull work; this is opt-in.\n`;
    expect(headlessSyncInstructions(bad)).not.toEqual([]);
  });

  it('rejects a headless-sync instruction preceded by a non-governing negation', () => {
    // Proximity negation cleared this: "not" sits just before "set".
    const bad = `For unattended sync, do not hesitate: set ${MASTER_KEY} and pull will work.\n`;
    expect(headlessSyncInstructions(bad)).not.toEqual([]);
  });

  it('accepts a genuine prohibition where the negation abuts the instruction', () => {
    const ok = `For unattended sync never set ${MASTER_KEY}; use the transport passphrase for push and pull.\n`;
    expect(headlessSyncInstructions(ok)).toEqual([]);
  });

  it('rejects a DOUBLE negative headless-sync instruction', () => {
    // "do not not set" is affirmative — an instruction wearing a denial's
    // clothes, and a one-word bypass of a single-token negation test.
    const bad = `For unattended sync, do not not set ${MASTER_KEY} so pull works.\n`;
    expect(headlessSyncInstructions(bad)).not.toEqual([]);
  });

  it('does not let a later match inherit an earlier match\'s context', () => {
    // The index-misalignment bug: a negated earlier instruction shifted every
    // later survivor onto the wrong surrounding text, so a real offender could
    // be judged against unrelated prose and escape.
    const bad = [
      `Never set ${MASTER_KEY} here.`,
      'x'.repeat(800),
      `On a headless worker box, set ${MASTER_KEY} so sync and pull work.`,
    ].join('\n\n');
    expect(headlessSyncInstructions(bad)).not.toEqual([]);
  });

  it('rejects the original blunt recommendation', () => {
    expect(recommendsForSharedMachines('Recommended for shared/CI machines.')).toBe(true);
  });

  it('exempts only what a marked region actually covers', () => {
    const marked = `${ALLOW_OPEN} -->\nExport ${MASTER_KEY} in ~/.zshenv.\n${ALLOW_CLOSE}\n`;
    expect(rcFileMentions(marked)).toEqual([]);
    // …and text after the region is still checked.
    expect(rcFileMentions(`${marked}Also export it in ~/.bashrc.\n`)).not.toEqual([]);
  });

  it('refuses to strip an unterminated region', () => {
    expect(() => stripAllowedRegions(`${ALLOW_OPEN} -->\nExport it in ~/.zshenv.\n`)).toThrow(/unterminated/);
  });
});
