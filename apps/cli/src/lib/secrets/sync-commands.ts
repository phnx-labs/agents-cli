/**
 * The argv tokens for the synchronous secrets-broker clients: the tokens
 * `agentGetSync`/`agentReachableSync`/`agentEvictSync` spawn, and the tokens
 * `index.ts` dispatches on before commander.
 *
 * This is a LEAF module — it imports nothing, so the CLI entrypoint can bind
 * these statically without dragging the secrets graph (and its `state.js` /
 * `install-helper.js` / `session-store.js` imports) into every invocation. That
 * is the whole reason the file exists: with the tokens in `agent.ts`, `index.ts`
 * had to repeat them as string literals, and the two could silently drift —
 * a drift with no visible failure mode, because the CLI answers "unknown
 * command", the client reads the non-zero exit as "broker down", and every
 * secret read falls back to a Touch ID prompt. Exactly the bug this subsystem
 * was fixed for. Sharing one binding makes that divergence a type error rather
 * than something a test has to notice.
 *
 * Same leaf discipline, and same motivation, as `lib/cli-entry.ts`.
 */
export const SYNC_GET_CMD = '__secrets-get';
export const SYNC_PING_CMD = '__secrets-ping';
export const SYNC_LOCK_CMD = '__secrets-lock';
