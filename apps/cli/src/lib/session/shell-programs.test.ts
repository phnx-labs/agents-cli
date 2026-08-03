import { describe, expect, it } from 'vitest';
import { extractShellPrograms, staticShellWord } from './shell-programs.js';
import { parse } from 'unbash';

describe('extractShellPrograms', () => {
  it('walks pipelines, control flow, substitutions, and process substitutions', () => {
    const result = extractShellPrograms(`
      if git status --short | grep .; then
        echo "$(gh pr view)" > >(sed 's/x/y/')
      fi
    `);

    expect(result.programs).toEqual(['git', 'grep', 'echo', 'gh', 'sed']);
    expect(result.diagnostics).toEqual([]);
  });

  it('recursively parses literal shell, ssh, and agents ssh payloads', () => {
    expect(extractShellPrograms(`bash -lc 'git merge topic'`).programs).toEqual(['bash', 'git']);
    expect(extractShellPrograms(`ssh box 'gh pr checks 42'`).programs).toEqual(['ssh', 'gh']);
    expect(extractShellPrograms(`agents ssh box 'rg TODO src'`).programs).toEqual(['agents', 'rg']);
  });

  it('does not claim a dynamically expanded program', () => {
    const command = parse('"$RUNNER" arg').commands[0].command;
    expect(command.type).toBe('Command');
    if (command.type !== 'Command') throw new Error('expected command');
    expect(staticShellWord(command.name)).toBeUndefined();
    expect(extractShellPrograms('"$RUNNER" arg').programs).toEqual([]);
  });

  it('explicitly traverses lazy Word.parts', () => {
    expect(extractShellPrograms('echo a$(git status)b').programs).toEqual(['echo', 'git']);
  });

  it('covers compound Bash forms without executing them', () => {
    const result = extractShellPrograms(`
      f() { git status; }
      (gh pr view) && { rg TODO src; }
      for x in a b; do printf '%s' "$x"; done
      case "$x" in a) sed -n 1p file;; esac
    `);
    expect(result.programs).toEqual(['git', 'gh', 'rg', 'printf', 'sed']);
    expect(result.diagnostics).toEqual([]);
  });

  it('delegates only conservative wrapper forms', () => {
    expect(extractShellPrograms('env A=1 git status').programs).toEqual(['env', 'git']);
    expect(extractShellPrograms('command git status').programs).toEqual(['command', 'git']);
    expect(extractShellPrograms('builtin printf test').programs).toEqual(['builtin', 'printf']);
    expect(extractShellPrograms('nohup git status').programs).toEqual(['nohup', 'git']);
    expect(extractShellPrograms('sudo git status').programs).toEqual(['sudo', 'git']);
    expect(extractShellPrograms('time git status').programs).toEqual(['git']);
    expect(extractShellPrograms('env -i git status').programs).toEqual(['env']);
    expect(extractShellPrograms('command -p git status').programs).toEqual(['command']);
    expect(extractShellPrograms('sudo -u root git status').programs).toEqual(['sudo']);
  });

  it('walks unquoted heredoc expansions but ignores quoted heredoc content', () => {
    expect(extractShellPrograms("cat <<EOF\n$(git status)\nEOF").programs).toEqual(['cat', 'git']);
    expect(extractShellPrograms("cat <<'EOF'\n$(must-not-parse)\nEOF").programs).toEqual(['cat']);
  });

  it('records malformed input and emits no derived program rows', () => {
    for (const source of ['if git status; then', 'echo $(git status', '(git status']) {
      const result = extractShellPrograms(source);
      expect(result.programs).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});
