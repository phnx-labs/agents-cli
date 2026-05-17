#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli
// Sets up shims directory and prints PATH instructions.
// Set AGENTS_INIT_SHELL=1 to opt in to automatic shell-rc mutation.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const SHIMS_DIR = path.join(HOME, '.agents', '.cache', 'shims');
const SYSTEM_DIR = path.join(HOME, '.agents-system');
const USER_DIR = path.join(HOME, '.agents');
const AGENTS_BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// For local installs, create directories and show a message
const isGlobalInstall = process.env.npm_config_global || process.argv.includes('-g');
if (!isGlobalInstall) {
  // Still create user directories for local installs
  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  console.log(`
agents-cli installed locally.
To complete setup, run: npx agents setup
`);
  process.exit(0);
}

// Create directories
fs.mkdirSync(SHIMS_DIR, { recursive: true });
fs.mkdirSync(SYSTEM_DIR, { recursive: true });
fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });

// One-shot idempotent migrations
function runMigrations() {
  // 1. Move agents.yaml from system to user repo
  const src = path.join(SYSTEM_DIR, 'agents.yaml');
  const dest = path.join(USER_DIR, 'agents.yaml');
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    try { fs.renameSync(src, dest); } catch { /* best-effort */ }
  }

  // 2. Delete dead prompts.json
  const promptsJson = path.join(SYSTEM_DIR, 'prompts.json');
  if (fs.existsSync(promptsJson)) {
    try { fs.unlinkSync(promptsJson); } catch { /* best-effort */ }
  }

  // 3. Move legacy config.json to ~/.agents/teams/config.json
  const configSrc = path.join(SYSTEM_DIR, 'config.json');
  const configDest = path.join(USER_DIR, 'teams', 'config.json');
  if (fs.existsSync(configSrc) && !fs.existsSync(configDest)) {
    try {
      fs.mkdirSync(path.dirname(configDest), { recursive: true });
      fs.copyFileSync(configSrc, configDest);
      fs.unlinkSync(configSrc);
    } catch { /* best-effort */ }
  }

  // 4. Move installed agent versions from ~/.agents/versions/ -> ~/.agents-system/versions/
  // Pre-split layout put binaries under the user repo. Post-split, listInstalledVersions
  // only scans the system root, so legacy installs become invisible without this move.
  const userVersions = path.join(USER_DIR, 'versions');
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  if (fs.existsSync(userVersions)) {
    try {
      let moved = 0;
      let skipped = 0;
      for (const agent of fs.readdirSync(userVersions, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        const srcAgentDir = path.join(userVersions, agent.name);
        const dstAgentDir = path.join(sysVersions, agent.name);
        try { fs.mkdirSync(dstAgentDir, { recursive: true }); } catch {}
        for (const ver of fs.readdirSync(srcAgentDir, { withFileTypes: true })) {
          if (!ver.isDirectory()) continue;
          const src = path.join(srcAgentDir, ver.name);
          const dst = path.join(dstAgentDir, ver.name);
          if (fs.existsSync(dst)) { skipped++; continue; }
          try { fs.renameSync(src, dst); moved++; } catch {}
        }
        try { if (fs.readdirSync(srcAgentDir).length === 0) fs.rmdirSync(srcAgentDir); } catch {}
      }
      try { if (fs.readdirSync(userVersions).length === 0) fs.rmdirSync(userVersions); } catch {}
      if (moved > 0) console.log(`  Migrated ${moved} agent version dir(s) to ~/.agents-system/versions/`);
      if (skipped > 0) console.log(`  Kept ${skipped} legacy version dir(s) at ~/.agents/versions/ (already present in system root)`);
    } catch { /* best-effort */ }
  }
}

runMigrations();

const shellName = path.basename(process.env.SHELL || '/bin/bash');

function getShellRc() {
  switch (shellName) {
    case 'zsh':
      return path.join(HOME, '.zshrc');
    case 'fish':
      return path.join(HOME, '.config', 'fish', 'config.fish');
    case 'bash':
      const bashProfile = path.join(HOME, '.bash_profile');
      if (fs.existsSync(bashProfile)) {
        return bashProfile;
      }
      return path.join(HOME, '.bashrc');
    default:
      return path.join(HOME, '.profile');
  }
}

const exportLine = shellName === 'fish'
  ? `fish_add_path ${SHIMS_DIR}`
  : `export PATH="${SHIMS_DIR}:$PATH"`;

// Shorthands that delegate to the installed agents-cli entrypoint.
const ALIASES = ['sessions', 'secrets', 'browser', 'pty', 'teams'];

function writeAliasShims() {
  const written = [];
  for (const name of ALIASES) {
    const target = path.join(SHIMS_DIR, name);
    const script = `#!/bin/sh\nAGENTS_BIN=${shellQuote(AGENTS_BIN)}\nif [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then\n  echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2\n  exit 127\nfi\nexec "$AGENTS_BIN" ${name} "$@"\n`;
    fs.writeFileSync(target, script, { mode: 0o755 });
    written.push(name);
  }
  return written;
}

function getVersion() {
  const pkgPath = new URL('../package.json', import.meta.url).pathname;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch { return null; }
}

function getChangelogSection(version) {
  const changelogPath = new URL('../CHANGELOG.md', import.meta.url).pathname;
  if (!fs.existsSync(changelogPath)) return null;
  const lines = fs.readFileSync(changelogPath, 'utf-8').split('\n');
  let inSection = false;
  const section = [];
  for (const line of lines) {
    if (line.startsWith(`## ${version}`)) { inSection = true; continue; }
    if (inSection && line.startsWith('## ')) break;
    if (inSection) section.push(line);
  }
  return section.length ? section.join('\n').trim() : null;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isAlreadyConfigured(rcFile) {
  if (!fs.existsSync(rcFile)) return false;
  const content = fs.readFileSync(rcFile, 'utf-8');
  // Accept either the new path or the legacy ~/.agents-system/shims path
  return content.includes('.agents/.cache/shims') || content.includes('.agents-system/shims');
}

async function main() {
  // Opt-in: AGENTS_INIT_SHELL=1 npm install -g @phnx-labs/agents-cli
  if (process.env.AGENTS_INIT_SHELL === '1') {
    const rcFile = getShellRc();
    if (!isAlreadyConfigured(rcFile)) {
      const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
      fs.mkdirSync(path.dirname(rcFile), { recursive: true });
      fs.appendFileSync(rcFile, addition);
      console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
      console.log(`  Restart your shell to enable version switching\n`);
    }
    writeAliasShims();
    console.log(`  Installed bare-command aliases: ${ALIASES.join(', ')}\n`);
  } else {
    // Default: offer to auto-add shims to PATH (like homebrew does)
    const rcFile = getShellRc();

    console.log(`\nagents-cli installed.`);

    if (!isAlreadyConfigured(rcFile) && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await ask(`\nAdd shims to PATH in ~/${path.basename(rcFile)}? [Y/n] `);
      if (answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
        fs.mkdirSync(path.dirname(rcFile), { recursive: true });
        fs.appendFileSync(rcFile, addition);
        console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
        console.log(`  Restart your shell or run: source ~/${path.basename(rcFile)}\n`);
      } else {
        console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
      }
    } else if (!isAlreadyConfigured(rcFile)) {
      console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
    }

    const written = writeAliasShims();
    console.log(`  Installed shorthands: ${written.join(', ')}`);
  }

  const version = getVersion();
  if (version) {
    const section = getChangelogSection(version);
    if (section) {
      console.log(`\nWhat's new in ${version}:\n`);
      console.log(section);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
