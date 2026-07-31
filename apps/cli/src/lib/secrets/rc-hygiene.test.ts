import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isCredentialName,
  scanRcExports,
  scanUserRcFiles,
  rcSecretWarningLines,
} from './rc-hygiene.js';

describe('isCredentialName', () => {
  it('flags the file-store master passphrase', () => {
    expect(isCredentialName('AGENTS_SECRETS_PASSPHRASE')).toBe(true);
  });

  it('flags credential-shaped names by their final segment', () => {
    for (const n of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DB_PASSWORD',
      'X_CLIENT_SECRET',
      'NPM_TOKEN',
      'GITHUB_PAT',
      'AWS_SECRET_ACCESS_KEY',
      'PASSWORD',
      'SECRET',
      'APIKEY',
    ]) {
      expect(isCredentialName(n), n).toBe(true);
    }
  });

  it('does NOT flag PATH-like or config vars that merely contain a secret word', () => {
    for (const n of [
      'PATH',
      'BUN_INSTALL',
      'PYENV_ROOT',
      'SSH_AUTH_SOCK',
      'GPG_TTY',
      'SOME_KEY_PATH', // ends PATH, not KEY
      'SSH_KEY_FILE', // ends FILE
      'TOKEN_DIR', // ends DIR
      'TOKENIZERS_PARALLELISM', // ML knob, ends PARALLELISM; TOKENIZERS is not the final segment
      'MONKEY', // single segment, not equal to KEY
      'CLIENT_ID', // ends ID
      'BUCKET_NAME', // ends NAME
    ]) {
      expect(isCredentialName(n), n).toBe(false);
    }
  });
});

describe('scanRcExports', () => {
  it('catches an export of the master passphrase and marks it', () => {
    const content = [
      '. "$HOME/.cargo/env"',
      'export PATH="$HOME/.local/bin:$PATH"',
      'export AGENTS_SECRETS_PASSPHRASE=deadbeefdeadbeefdeadbeefdeadbeef',
    ].join('\n');
    const found = scanRcExports('.zshenv', content);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: '.zshenv', line: 3, name: 'AGENTS_SECRETS_PASSPHRASE', isMasterPassphrase: true });
  });

  it('NEVER captures the value — only the name and line', () => {
    const secret = 'super-secret-value-1234567890';
    const found = scanRcExports('.zshrc', `export API_TOKEN=${secret}`);
    expect(found).toHaveLength(1);
    // The finding must not carry the value anywhere in its serialized form.
    expect(JSON.stringify(found[0])).not.toContain(secret);
    expect(Object.values(found[0])).not.toContain(secret);
  });

  it('catches typeset -x / declare -x export-attribute forms', () => {
    expect(scanRcExports('.bashrc', 'typeset -x GITHUB_TOKEN=abc')).toHaveLength(1);
    expect(scanRcExports('.bashrc', 'declare -x DB_PASSWORD=abc')).toHaveLength(1);
  });

  it('ignores commented-out exports', () => {
    expect(scanRcExports('.zshenv', '# export API_KEY=abc')).toEqual([]);
    expect(scanRcExports('.zshenv', '   #export SECRET=abc')).toEqual([]);
  });

  it('does not flag PATH or other non-credential exports', () => {
    const content = [
      'export PATH="$HOME/.local/bin:$PATH"',
      'export BUN_INSTALL="$HOME/.bun"',
      'export EDITOR=vim',
    ].join('\n');
    expect(scanRcExports('.zshrc', content)).toEqual([]);
  });

  it('reports multiple findings with correct line numbers', () => {
    const content = [
      'export PATH=/usr/bin', // 1
      'export ANTHROPIC_API_KEY=x', // 2
      '# comment', // 3
      'export NPM_TOKEN=y', // 4
    ].join('\n');
    const found = scanRcExports('.zprofile', content);
    expect(found.map((f) => [f.line, f.name])).toEqual([
      [2, 'ANTHROPIC_API_KEY'],
      [4, 'NPM_TOKEN'],
    ]);
    expect(found.every((f) => f.isMasterPassphrase === false)).toBe(true);
  });

  it('flags a value sourced from a command substitution — it still lands in the env', () => {
    const found = scanRcExports('.zshenv', 'export AGENTS_SECRETS_PASSPHRASE="$(cat ~/.pass)"');
    expect(found).toHaveLength(1);
    expect(found[0].isMasterPassphrase).toBe(true);
  });
});

describe('scanUserRcFiles', () => {
  it('aggregates findings across a real home dir of rc files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hygiene-'));
    try {
      fs.writeFileSync(path.join(dir, '.zshenv'), 'export AGENTS_SECRETS_PASSPHRASE=abc\nexport PATH=/x\n');
      fs.writeFileSync(path.join(dir, '.zshrc'), 'export OPENAI_API_KEY=xyz\n');
      // a benign file with no secrets
      fs.writeFileSync(path.join(dir, '.profile'), 'export PATH=/y\n');
      const found = scanUserRcFiles(dir);
      expect(found.map((f) => `${f.file}:${f.name}`).sort()).toEqual([
        '.zshenv:AGENTS_SECRETS_PASSPHRASE',
        '.zshrc:OPENAI_API_KEY',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a home dir with no rc files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hygiene-empty-'));
    try {
      expect(scanUserRcFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rcSecretWarningLines', () => {
  it('is silent with no findings', () => {
    expect(rcSecretWarningLines([])).toEqual([]);
  });

  it('calls out the master passphrase with the off-env remediation', () => {
    const lines = rcSecretWarningLines([
      { file: '.zshenv', line: 3, name: 'AGENTS_SECRETS_PASSPHRASE', isMasterPassphrase: true },
    ]);
    expect(lines[0]).toContain('1 credential-shaped export');
    expect(lines.some((l) => l.includes('AGENTS_SECRETS_PASSPHRASE') && l.includes('.secrets-key/passphrase'))).toBe(true);
  });

  it('points non-master credentials at `agents secrets exec`', () => {
    const lines = rcSecretWarningLines([
      { file: '.zshrc', line: 5, name: 'NPM_TOKEN', isMasterPassphrase: false },
    ]);
    expect(lines.some((l) => l.includes('NPM_TOKEN') && l.includes('agents secrets exec'))).toBe(true);
  });

  it('never echoes a value (there is none to echo) and pluralizes correctly', () => {
    const lines = rcSecretWarningLines([
      { file: '.zshenv', line: 3, name: 'AGENTS_SECRETS_PASSPHRASE', isMasterPassphrase: true },
      { file: '.zshrc', line: 5, name: 'NPM_TOKEN', isMasterPassphrase: false },
    ]);
    expect(lines[0]).toContain('2 credential-shaped exports');
  });
});
