#!/usr/bin/env node
// agi-cli is the front-brand alias of @phnx-labs/agents-cli. The commands
// `agents`, `ag`, and `agi` all resolve here and exec the exact same tool.
//
// We spawn the canonical entry as the process' main module (rather than
// importing it in-process) so that any `argv[1]`-based main-module guard in
// the canonical CLI fires correctly, regardless of how it was invoked.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the canonical package's `.` export (ESM-only, so import.meta.resolve —
// not require.resolve, whose subpath/require condition the exports map blocks).
const entry = fileURLToPath(import.meta.resolve("@phnx-labs/agents-cli"));

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
