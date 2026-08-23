import { describe, expect, it } from 'vitest';
import { extractShellPrograms, isShellExecTool, SHELL_EXEC_TOOLS, staticShellWord } from './shell-programs.js';
import { parse } from 'unbash';

describe('isShellExecTool', () => {
  it('recognizes every harness shell-exec tool name, case-insensitively', () => {
    // The names each harness actually emits as its shell tool, in their native casing.
    for (const tool of ['Bash', 'exec_command', 'exec', 'run_shell_command', 'shell', 'Execute', 'run_command', 'execute']) {
      expect(isShellExecTool(tool)).toBe(true);
      expect(isShellExecTool(tool.toUpperCase())).toBe(true);
    }
  });

  it('rejects non-shell tools and empty input', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Task', 'WebFetch', 'apply_patch', '', undefined]) {
      expect(isShellExecTool(tool as string | undefined)).toBe(false);
    }
  });

  it('is the single source of truth — SHELL_EXEC_TOOLS is stored lowercased', () => {
    for (const name of SHELL_EXEC_TOOLS) expect(name).toBe(name.toLowerCase());
  });
});

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

  it('unwraps static wrapper chains without executing them', () => {
    expect(extractShellPrograms('env A=1 git status').programs).toEqual(['env', 'git']);
    expect(extractShellPrograms('command git status').programs).toEqual(['command', 'git']);
    expect(extractShellPrograms('builtin printf test').programs).toEqual(['builtin', 'printf']);
    expect(extractShellPrograms('nohup git status').programs).toEqual(['nohup', 'git']);
    expect(extractShellPrograms('sudo git status').programs).toEqual(['sudo', 'git']);
    expect(extractShellPrograms('time git status').programs).toEqual(['git']);
    expect(extractShellPrograms('env -i git status').programs).toEqual(['env', 'git']);
    expect(extractShellPrograms('command -p git status').programs).toEqual(['command', 'git']);
    expect(extractShellPrograms('sudo -u root git status').programs).toEqual(['sudo', 'git']);
    expect(extractShellPrograms('sudo -u root env A=1 git status').occurrences).toEqual([
      { program: 'sudo', role: 'wrapper' },
      { program: 'env', role: 'wrapper' },
      { program: 'git', role: 'effective' },
    ]);
  });

  it('retains repeated static program sites while preserving the distinct program list', () => {
    const result = extractShellPrograms('git status; git diff; bash -lc "git log -1"');
    expect(result.programs).toEqual(['git', 'bash']);
    expect(result.occurrences).toEqual([
      { program: 'git', role: 'effective' },
      { program: 'git', role: 'effective' },
      { program: 'bash', role: 'wrapper' },
      { program: 'git', role: 'effective' },
    ]);
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
