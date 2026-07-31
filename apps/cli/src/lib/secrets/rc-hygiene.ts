/**
 * Detect credentials exported from shell rc files.
 *
 * A secret exported from `~/.zshenv`, `~/.zshrc`, `~/.bashrc`, `~/.profile`, …
 * is inherited by every process the login shell spawns and is readable from
 * `/proc/<pid>/environ` by any same-user process — the master passphrase leak
 * behind RUSH-1968. `.zshenv` in particular is sourced by *every* zsh
 * invocation, including non-interactive `ssh host 'cmd'`, so the value lands in
 * the environment of essentially everything the box runs.
 *
 * The keychain-backed store (`agents secrets`) is the sanctioned home for
 * credentials; the file-store master passphrase belongs in the off-env 0600 key
 * file (`~/.agents/.secrets-key/passphrase`), never a shell rc export.
 *
 * This scanner powers a warn-level advisory in `agents doctor`. It reads only
 * the exported variable *name* and its line number — never the value — so a
 * finding can be printed, logged, or shipped without leaking the secret.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Shell rc files sourced at login/startup, in the order a report lists them. */
export const RC_FILENAMES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.bash_profile',
  '.bash_login',
  '.bashrc',
  '.profile',
  '.kshrc',
] as const;

/**
 * A single credential-shaped export found in an rc file. Carries the variable
 * NAME and location only — the value is never captured.
 */
export interface RcSecretFinding {
  /** Basename of the rc file, e.g. `.zshenv`. */
  file: string;
  /** 1-based line number of the export. */
  line: number;
  /** The exported variable name (e.g. `AGENTS_SECRETS_PASSPHRASE`). Never the value. */
  name: string;
  /** The file-store master passphrase gets called out separately — it is the highest-severity case. */
  isMasterPassphrase: boolean;
}

/** The file-store master key. Its own resolution prefers an off-env 0600 file, so
 *  a shell-rc export is always wrong once the store exists (RUSH-1968). */
const MASTER_PASSPHRASE = 'AGENTS_SECRETS_PASSPHRASE';

/**
 * Last `_`-delimited segment values that mark a variable as credential-shaped.
 * Matched against the FINAL segment (segment equality, not substring) so
 * `X_API_KEY` fires on `KEY` while `SOME_KEY_PATH` (ends `PATH`) and `MONKEY`
 * (single segment, not equal to `KEY`) do not.
 */
const CREDENTIAL_SEGMENTS = new Set([
  'PASSPHRASE',
  'PASSWORD',
  'PASSWD',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'KEY',
  'APIKEY',
  'PAT',
  'CREDENTIAL',
  'CREDENTIALS',
]);

/**
 * Final segments that look credential-shaped but name a file path, socket, or
 * config knob rather than a secret value — excluded to cut false positives.
 * Applied to the whole name's final segment before the credential check.
 */
const BENIGN_FINAL_SEGMENTS = new Set([
  'PATH',
  'FILE',
  'DIR',
  'SOCK',
  'SOCKET',
  'ID',
  'NAME',
  'PARALLELISM', // TOKENIZERS_PARALLELISM and friends
]);

/** True if a variable name looks like it holds a credential value. */
export function isCredentialName(name: string): boolean {
  if (name === MASTER_PASSPHRASE) return true;
  const segments = name.toUpperCase().split('_');
  const last = segments[segments.length - 1];
  if (BENIGN_FINAL_SEGMENTS.has(last)) return false;
  return CREDENTIAL_SEGMENTS.has(last);
}

// Matches an env assignment that puts a value in the environment:
//   export NAME=...            (sh/bash/zsh)
//   typeset -x NAME=... / declare -x NAME=...   (bash/zsh export-attribute form)
const EXPORT_RE =
  /^\s*(?:export\s+|(?:typeset|declare)\s+-[A-Za-z]*x[A-Za-z]*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Scan one rc file's contents for credential-shaped exports. Pure — takes the
 * text, returns findings (names + line numbers only, never values). A trailing
 * `# comment` is stripped before matching so a commented-out export is ignored;
 * the variable name always precedes any inline `#`, so stripping never loses it.
 */
export function scanRcExports(basename: string, content: string): RcSecretFinding[] {
  const out: RcSecretFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, '');
    const m = EXPORT_RE.exec(code);
    if (!m) continue;
    const name = m[1];
    if (!isCredentialName(name)) continue;
    out.push({
      file: basename,
      line: i + 1,
      name,
      isMasterPassphrase: name === MASTER_PASSPHRASE,
    });
  }
  return out;
}

/**
 * Scan the current user's shell rc files. Reads each file that exists under
 * `homeDir` (default `os.homedir()`) and aggregates the findings. Missing or
 * unreadable files are skipped silently — an advisory, not a hard requirement.
 */
export function scanUserRcFiles(homeDir: string = os.homedir()): RcSecretFinding[] {
  const out: RcSecretFinding[] = [];
  for (const name of RC_FILENAMES) {
    const fp = path.join(homeDir, name);
    let content: string;
    try {
      content = fs.readFileSync(fp, 'utf8');
    } catch {
      continue; // absent or unreadable — nothing to report
    }
    out.push(...scanRcExports(name, content));
  }
  return out;
}

/**
 * Build the advisory lines for `agents doctor` from a set of findings. Returns
 * `[]` when there is nothing to report. The first line is the headline; the
 * rest are indented detail. Names only — never values.
 */
export function rcSecretWarningLines(findings: RcSecretFinding[]): string[] {
  if (findings.length === 0) return [];
  const lines: string[] = [];
  const master = findings.filter((f) => f.isMasterPassphrase);
  const others = findings.filter((f) => !f.isMasterPassphrase);

  const total = findings.length;
  lines.push(
    `${total} credential-shaped export${total === 1 ? '' : 's'} found in shell rc files — ` +
    `readable from /proc/<pid>/environ by any same-user process.`,
  );
  for (const f of master) {
    lines.push(
      `${f.file}:${f.line} ${f.name} — the file-store master key. Move it off-env to ` +
      `~/.agents/.secrets-key/passphrase (chmod 600) and delete the export.`,
    );
  }
  for (const f of others) {
    lines.push(`${f.file}:${f.line} ${f.name} — move to \`agents secrets\` and inject via \`agents secrets exec\`.`);
  }
  lines.push('Rule: no credentials in env vars or shell config. Use the keychain-backed store.');
  return lines;
}
