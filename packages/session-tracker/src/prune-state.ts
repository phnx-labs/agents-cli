#!/usr/bin/env node
// Prune stale entries from the SessionStart hook state directory.
// Called by hook.sh after a successful write so the directory never accumulates
// dead-pid records, zero-byte files, or orphaned temp files.

import { cleanupOrphanedStateFiles } from './state-file.js';

await cleanupOrphanedStateFiles();
// Stay silent — stdout from SessionStart hooks leaks into the model context.
