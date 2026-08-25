// The embedded observe -> act -> verify loop behind `agents computer run`.
//
// This module owns ONLY the decision logic: given a reasoning model (a
// boundary, injected as `responder`) and a verb dispatcher (the existing
// computer-helper RPC surface, injected as `dispatch`), it drives the model's
// tool calls against the daemon, step by step, until the model declares the
// task done or `maxSteps` is hit.
//
// The model and the daemon are boundaries — neither is code under test. The
// loop itself (verb ordering, max-steps, the AX -> vision fallback) is the
// unit under test. See loop.test.ts, which injects a scripted fake responder
// and a fake dispatcher.

// A single tool call the model wants to run this turn. `name` is a CLI verb
// (describe, screenshot, click, ...), NOT an RPC method — the dispatcher owns
// the verb -> RPC mapping so external-agent callers of the verbs are untouched.
export interface VerbCall {
  name: string;
  input: Record<string, unknown>;
}

// The outcome of dispatching one verb. Mirrors the RPC envelope shape
// (result-or-error) so the real dispatcher is a thin adapter over
// openComputerClient().call().
export interface VerbResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// One step of the transcript: the call the model made and what came back.
// `visionFallback` marks the describe step that tripped the AX -> vision
// switch (its auto-injected screenshot follows as the next step).
export interface LoopStep {
  call: VerbCall;
  result: VerbResult;
  visionFallback?: boolean;
}

// The running state handed to the responder each turn so it can decide the
// next move. Kept serialisable so the default Claude responder can render it
// straight into a messages array.
export interface LoopState {
  task: string;
  steps: LoopStep[];
  // Flipped true the first time a describe comes back AX-opaque. Once set, the
  // loop steers the model toward the coordinate/vision path for that surface.
  visionMode: boolean;
}

// What the model decides for a turn: either run some tool calls, or finish.
export interface ModelDecision {
  toolCalls: VerbCall[];
  done?: { text: string };
}

export type ModelResponder = (state: LoopState) => ModelDecision | Promise<ModelDecision>;
export type VerbDispatcher = (call: VerbCall) => VerbResult | Promise<VerbResult>;

export interface LoopConfig {
  task: string;
  responder: ModelResponder;
  dispatch: VerbDispatcher;
  // Max model turns before the loop gives up. A "turn" is one responder call,
  // regardless of how many tool calls it emits.
  maxSteps: number;
  // Fired after every dispatched verb (incl. auto-injected screenshots) so the
  // command layer can stream progress. Optional; pure loop logic ignores it.
  onEvent?: (event: LoopEvent) => void;
}

export type LoopEvent =
  | { kind: 'turn'; index: number }
  | { kind: 'dispatch'; call: VerbCall; result: VerbResult; visionFallback?: boolean }
  | { kind: 'vision_switch'; describe: VerbResult }
  | { kind: 'done'; text: string }
  | { kind: 'max_steps' };

export interface LoopResult {
  status: 'done' | 'max_steps';
  finalText?: string;
  steps: LoopStep[];
  // Every verb name dispatched, in order, including auto-injected screenshots.
  // The primary assertion surface for the loop's ordering behavior.
  dispatched: string[];
  visionMode: boolean;
  turns: number;
}

// Below this many AX elements the tree is treated as opaque — a WebView, a
// Qt/Electron surface that never populated its AX tree, or a canvas app. The
// model then works from pixels + coordinate clicks instead of element ids.
export const AX_OPAQUE_ELEMENT_THRESHOLD = 3;

// Describe-time heuristic. An explicit `ax_opaque: true` from the daemon wins.
// Otherwise: a failed describe is NOT opaque (it's an error, surface it), and a
// successful one is opaque when its element_count is at/under the threshold or
// its tree has no children. Pure so the rule is unit-testable in isolation.
export function isAxOpaque(result: VerbResult): boolean {
  const r = result.result ?? {};
  if (r.ax_opaque === true) return true;
  if (!result.ok) return false;

  const count = typeof r.element_count === 'number' ? r.element_count : undefined;
  if (count !== undefined) return count <= AX_OPAQUE_ELEMENT_THRESHOLD;

  const tree = r.tree as { children?: unknown } | null | undefined;
  const children = tree && Array.isArray(tree.children) ? tree.children : [];
  return children.length === 0;
}

// Drive the loop to completion. Returns the transcript, the ordered verb names
// dispatched, and whether the vision fallback ever fired.
export async function runComputerLoop(config: LoopConfig): Promise<LoopResult> {
  const state: LoopState = { task: config.task, steps: [], visionMode: false };
  const dispatched: string[] = [];
  const emit = config.onEvent ?? (() => {});

  let turns = 0;
  while (turns < config.maxSteps) {
    emit({ kind: 'turn', index: turns });
    turns++;

    const decision = await config.responder(state);

    if (decision.done) {
      emit({ kind: 'done', text: decision.done.text });
      return {
        status: 'done',
        finalText: decision.done.text,
        steps: state.steps,
        dispatched,
        visionMode: state.visionMode,
        turns,
      };
    }

    for (const call of decision.toolCalls) {
      const result = await config.dispatch(call);
      dispatched.push(call.name);

      // AX -> vision fallback. When a describe comes back opaque, the element
      // ids the model would click are useless, so the loop flips visionMode and
      // immediately hands the model pixels: it auto-dispatches a screenshot of
      // the same target. The explicit verbs stay untouched for external callers
      // — this switch lives entirely in the loop.
      if (call.name === 'describe' && isAxOpaque(result)) {
        state.visionMode = true;
        state.steps.push({ call, result, visionFallback: true });
        emit({ kind: 'dispatch', call, result, visionFallback: true });
        emit({ kind: 'vision_switch', describe: result });

        const shotCall: VerbCall = { name: 'screenshot', input: pickTargetInput(call.input) };
        const shot = await config.dispatch(shotCall);
        dispatched.push(shotCall.name);
        state.steps.push({ call: shotCall, result: shot });
        emit({ kind: 'dispatch', call: shotCall, result: shot });
        continue;
      }

      state.steps.push({ call, result });
      emit({ kind: 'dispatch', call, result });
    }
  }

  emit({ kind: 'max_steps' });
  return {
    status: 'max_steps',
    steps: state.steps,
    dispatched,
    visionMode: state.visionMode,
    turns,
  };
}

// Carry the target selector (pid/bundle) from the describe call onto the
// auto-injected screenshot so the vision fallback captures the same surface.
function pickTargetInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.pid != null) out.pid = input.pid;
  if (input.bundle != null) out.bundle = input.bundle;
  return out;
}
