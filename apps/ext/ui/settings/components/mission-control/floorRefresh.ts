// Floor refresh / animation timing constants (issue #2030).
// Kept out of UnifiedAgentsPane so unit tests can import without loading the shell.

/** UI age cue for the host-freshness chip — not a poll interval. */
export const REMOTE_STALE_MS = 90_000

/** Throughput sparkline React state tick; CSS interpolates between ticks. */
export const THROUGHPUT_TICK_MS = 1_000
