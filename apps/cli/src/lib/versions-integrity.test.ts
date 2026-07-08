import { describe, expect, it } from 'vitest';
import { isMissingBinarySignature, probeSpawnSpec } from './versions.js';

/**
 * isMissingBinarySignature is the gate that decides whether a freshly-installed
 * agent's `--version` probe failure means "the runnable binary is missing"
 * (a gutted install we must reject) versus an ordinary nonzero exit we must
 * tolerate. Getting this wrong either lets a broken install become the default
 * (the ENOENT bug) or false-fails a healthy one.
 */
describe('isMissingBinarySignature (gutted-install detector)', () => {
  it('flags the real codex ENOENT crash (wrapper present, native binary missing)', () => {
    const blob =
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/' +
      '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT';
    expect(isMissingBinarySignature(blob)).toBe(true);
  });

  it('flags the other missing-file phrasings', () => {
    expect(isMissingBinarySignature('bash: codex: command not found')).toBe(true);
    expect(isMissingBinarySignature('dyld: no such file or directory')).toBe(true);
    expect(isMissingBinarySignature("'codex' is not recognized as an internal or external command")).toBe(true);
  });

  it('does NOT flag an agent that merely dislikes --version (ordinary nonzero exit)', () => {
    expect(isMissingBinarySignature('error: unknown option `--version`')).toBe(false);
    expect(isMissingBinarySignature('Usage: codex [options] <command>')).toBe(false);
    expect(isMissingBinarySignature('')).toBe(false);
  });

  it('does NOT match on unrelated text that merely contains a substring like "enoent"', () => {
    // Word-boundaried: only a standalone ENOENT token counts, not e.g. a hash.
    expect(isMissingBinarySignature('token: abcENOENTxyz')).toBe(false);
  });
});

/**
 * probeSpawnSpec builds the argv for the `<binary> --version` launch probe. The
 * load-bearing case: on Windows the `.cmd` runs through cmd.exe, so a spaced
 * profile path (`C:\Users\John Doe\…`) MUST be fully quoted — else cmd.exe splits
 * it at the space, emits "'C:\Users\John' is not recognized", trips
 * isMissingBinarySignature, and false-fails a HEALTHY install into a destructive
 * reinstall. The probe must compose the quoted line + empty args (never let Node
 * concatenate the path into a shell string unescaped).
 */
describe('probeSpawnSpec (launch-probe quoting)', () => {
  it('fully quotes a SPACED Windows .cmd path and empties the args array', () => {
    const spaced =
      'C:\\Users\\John Doe\\.agents\\.history\\versions\\claude\\2.1.191\\node_modules\\.bin\\claude.cmd';
    const spec = probeSpawnSpec(spaced, true);
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]); // args never concatenated into the cmd.exe line
    // The path is wrapped in quotes so cmd.exe reads it as one token, not split at the space.
    expect(spec.command).toBe(`"${spaced}" --version`);
    // The bug (raw path) would start with C, not a quote, and cmd.exe would stop at the space.
    expect(spec.command.startsWith('"')).toBe(true);
  });

  it('does not quote a space-free Windows path (nothing to escape) but keeps empty args', () => {
    const p = 'C:\\Users\\muqsit\\.agents\\...\\claude.cmd';
    const spec = probeSpawnSpec(p, true);
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]);
    expect(spec.command).toBe(`${p} --version`);
  });

  it('POSIX: no shell, binary exec\'d directly with --version', () => {
    const p = '/home/user/.agents/.history/versions/claude/2.1.191/node_modules/.bin/claude';
    const spec = probeSpawnSpec(p, false);
    expect(spec.shell).toBe(false);
    expect(spec.command).toBe(p);
    expect(spec.args).toEqual(['--version']);
  });
});
