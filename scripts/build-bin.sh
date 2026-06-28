#!/usr/bin/env bash
#
# Build the agents-cli standalone Bun executable into ./dist/bin/agents.
#
# Cross-compile later with:
#   BUN_COMPILE_TARGET=bun-linux-x64 scripts/build-bin.sh
#   BUN_COMPILE_TARGET=bun-linux-arm64 scripts/build-bin.sh
#   BUN_COMPILE_TARGET=bun-darwin-arm64 scripts/build-bin.sh
#   BUN_COMPILE_TARGET=bun-darwin-x64 scripts/build-bin.sh
#   BUN_COMPILE_TARGET=bun-windows-x64 scripts/build-bin.sh

set -euo pipefail

cd "$(dirname "$0")/.."

command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

OUT_DIR="dist/bin"
OUT="$OUT_DIR/agents"
BUILD_DIR="$OUT_DIR/.compile-src"
VERSION="$(node -p "require('./package.json').version")"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

cp -R src "$BUILD_DIR/src"

BUILD_DIR="$BUILD_DIR" VERSION="$VERSION" node <<'NODE'
const fs = require('fs');
const path = require('path');

const buildDir = process.env.BUILD_DIR;
const version = process.env.VERSION;
if (!buildDir || !version) throw new Error('BUILD_DIR and VERSION are required');

const indexPath = path.join(buildDir, 'src', 'index.ts');
let index = fs.readFileSync(indexPath, 'utf8');
const versionBlock = [
  "const packageJsonPath = path.join(__dirname, '..', 'package.json');",
  "const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));",
  "const VERSION = packageJson.version;",
].join('\n');
if (!index.includes(versionBlock)) {
  throw new Error('src/index.ts version block changed; update scripts/build-bin.sh');
}
index = index.replace(versionBlock, `const VERSION = ${JSON.stringify(version)};`);
fs.writeFileSync(indexPath, index);

const ptyClientPath = path.join(buildDir, 'src', 'lib', 'pty-client.ts');
let ptyClient = fs.readFileSync(ptyClientPath, 'utf8');
const spawnBlock = [
  'function getServerSpawnArgs(): { bin: string; args: string[] } {',
  '  // Prefer the dist/index.js from the same installation as this code.',
].join('\n');
if (!ptyClient.includes(spawnBlock)) {
  throw new Error('src/lib/pty-client.ts spawn block changed; update scripts/build-bin.sh');
}
ptyClient = ptyClient.replace(spawnBlock, [
  'function getServerSpawnArgs(): { bin: string; args: string[] } {',
  "  if ((globalThis as any).Bun?.isStandaloneExecutable) {",
  "    return { bin: process.execPath, args: ['pty', '_server'] };",
  '  }',
  '',
  '  // Prefer the dist/index.js from the same installation as this code.',
].join('\n'));
fs.writeFileSync(ptyClientPath, ptyClient);
NODE

args=(bun build "$BUILD_DIR/src/index.ts" --compile --outfile "$OUT")
if [[ -n "${BUN_COMPILE_TARGET:-}" ]]; then
  args+=(--target="$BUN_COMPILE_TARGET")
fi

"${args[@]}"
chmod 755 "$OUT"
