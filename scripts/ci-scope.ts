#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs';

export interface CiScope {
  cli: boolean;
  cliDocs: boolean;
  factory: boolean;
  sessionTracker: boolean;
  windows: boolean;
}

const FORCE_ALL_PATHS = new Set([
  'scripts/ci-scope.ts',
  'scripts/ci-scope.test.ts',
]);

function isCliDocumentation(file: string): boolean {
  return file.startsWith('apps/cli/docs/')
    || file.startsWith('apps/cli/.changelog/')
    || [
      'apps/cli/AGENTS.md',
      'apps/cli/CHANGELOG.md',
      'apps/cli/README.md',
    ].includes(file);
}

function isWindowsSensitive(file: string): boolean {
  return file === 'apps/cli/src/lib/hooks.ts'
    || file.startsWith('apps/cli/src/lib/hooks/')
    || file.startsWith('apps/cli/src/lib/platform/')
    || /^apps\/cli\/src\/lib\/shims[^/]*\.ts$/.test(file)
    || file.startsWith('apps/cli/hooks/')
    || file.startsWith('apps/cli/src/lib/hosts/');
}

export function classifyCiScope(files: readonly string[]): CiScope {
  const scope: CiScope = {
    cli: false,
    cliDocs: false,
    factory: false,
    sessionTracker: false,
    windows: false,
  };

  for (const file of files) {
    if (FORCE_ALL_PATHS.has(file) || file.startsWith('.github/workflows/')) {
      return {
        cli: true,
        cliDocs: true,
        factory: true,
        sessionTracker: true,
        windows: true,
      };
    }

    if (file.startsWith('apps/cli/')) {
      if (isCliDocumentation(file)) {
        scope.cliDocs = true;
      } else {
        scope.cli = true;
      }
      if (isWindowsSensitive(file)) scope.windows = true;
    }

    if (file.startsWith('apps/factory/')) scope.factory = true;
    if (file.startsWith('packages/session-tracker/')) scope.sessionTracker = true;
  }

  return scope;
}

export function formatGitHubOutputs(scope: CiScope): string {
  return [
    `cli=${scope.cli}`,
    `cli_docs=${scope.cliDocs}`,
    `factory=${scope.factory}`,
    `session_tracker=${scope.sessionTracker}`,
    `windows=${scope.windows}`,
  ].join('\n') + '\n';
}

function readChangedFiles(): string[] {
  const input = readFileSync(0);
  const separator = input.includes(0) ? '\0' : '\n';
  return input.toString('utf8').split(separator).filter(Boolean);
}

function main(): void {
  const files = readChangedFiles();
  const output = formatGitHubOutputs(classifyCiScope(files));
  const githubOutput = process.argv[2];
  if (githubOutput) appendFileSync(githubOutput, output);
  else process.stdout.write(output);

  process.stderr.write(`CI scope: ${files.length} changed files\n${output}`);
}

if (import.meta.main) main();
