/**
 * Progress routing for `agents run --lease`.
 *
 * The box-side bootstrap emits `LEASE_AGENT_MARKER` on its own line right before
 * `agents run`. Everything the crabbox run streams BEFORE that marker is setup
 * noise (sync bytes, node/agents install, `agents setup`) — shown as spinner
 * text and captured for a failure dump. Everything AFTER is the agent's own
 * output — printed through verbatim. The marker line itself is swallowed.
 */

/** Sentinel echoed on the box right before `agents run`. Distinctive + collision-proof. */
export const LEASE_AGENT_MARKER = '___AGENTS_LEASE_AGENT_OUTPUT_b1f4c2___';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  /** Begin animating a phase (renders `frame text` on one line, TTY only). */
  start(text: string): void;
  /** Change the text shown; rendered on the next throttled tick (no write itself). */
  update(text: string): void;
  /** Finalize the current line with a symbol (e.g. ✔) and a newline. */
  stopAndPersist(symbol: string, text: string): void;
  /** Clear the current animated line without persisting anything. */
  stop(): void;
  /** True while a phase is active. */
  readonly active: boolean;
}

/**
 * A deliberately minimal, self-throttled spinner. Unlike `ora`, it does NOT hook
 * the stream's `write` to re-render on external output — it writes exactly one
 * short line per fixed tick and nowhere else, so it is structurally incapable of
 * a re-render feedback loop (the failure mode that made `ora` blow up when a
 * lease streamed output past a live spinner). On a non-TTY it prints each phase
 * label once and stays silent on `update`, so piped/CI output never floods.
 *
 * Only ever run ONE phase at a time, and never stream other output to the same
 * stream while a phase is active — stop it first.
 */
export function createSpinner(opts: {
  stream?: { write(s: string): unknown; isTTY?: boolean };
  enabled?: boolean;
  intervalMs?: number;
} = {}): Spinner {
  const stream = opts.stream ?? process.stderr;
  const enabled = opts.enabled ?? !!(stream as { isTTY?: boolean }).isTTY;
  const intervalMs = opts.intervalMs ?? 120;
  const CLEAR = '\r\u001b[2K';
  let text = '';
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const write = (s: string) => stream.write(s);
  return {
    start(t: string) {
      text = t;
      running = true;
      if (!enabled) {
        write(`${t}\n`);
        return;
      }
      if (timer) return;
      frame = 0;
      write(`${CLEAR}${SPINNER_FRAMES[0]} ${text}`);
      timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        write(`${CLEAR}${SPINNER_FRAMES[frame]} ${text}`);
      }, intervalMs);
    },
    update(t: string) {
      text = t; // next tick renders it; on a non-TTY we stay silent (no flood)
    },
    stopAndPersist(symbol: string, t: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      running = false;
      write(enabled ? `${CLEAR}${symbol} ${t}\n` : `${symbol} ${t}\n`);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
        if (enabled) write(CLEAR);
      }
      running = false;
    },
    get active() {
      return running;
    },
  };
}

export interface LeaseOutputRouter {
  /** Feed a raw chunk of the crabbox run's combined stdout/stderr. */
  push(chunk: string): void;
  /** Flush any buffered partial line (call once the stream closes). */
  end(): void;
  /** True once the agent-output marker has been seen. */
  sawAgent(): boolean;
  /** The setup lines seen so far (for a failure dump). */
  setupLines(): string[];
}

/**
 * Split the crabbox run stream at `LEASE_AGENT_MARKER`. `onSetupLine` fires for
 * each complete non-empty line before the marker; `onAgentChunk` fires with raw
 * text after it (streamed promptly, not line-buffered, so agent output is live).
 */
export function createLeaseOutputRouter(cb: {
  onSetupLine: (line: string) => void;
  onAgentChunk: (chunk: string) => void;
  marker?: string;
}): LeaseOutputRouter {
  const marker = cb.marker ?? LEASE_AGENT_MARKER;
  let seen = false;
  let buf = '';
  const setup: string[] = [];

  const emitLine = (line: string) => {
    const t = line.replace(/\r$/, '');
    if (t.trim()) {
      setup.push(t);
      cb.onSetupLine(t);
    }
  };

  return {
    push(chunk: string) {
      if (seen) {
        cb.onAgentChunk(chunk);
        return;
      }
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.includes(marker)) {
          seen = true;
          // Anything already buffered past the marker is agent output.
          if (buf) {
            cb.onAgentChunk(buf);
            buf = '';
          }
          return;
        }
        emitLine(line);
      }
      // A trailing partial line stays in `buf` — it may be the marker forming.
    },
    end() {
      if (!seen && buf) emitLine(buf);
      buf = '';
    },
    sawAgent() {
      return seen;
    },
    setupLines() {
      return setup;
    },
  };
}
